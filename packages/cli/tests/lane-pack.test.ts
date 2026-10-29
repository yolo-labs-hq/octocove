import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { applyDelta, MAX_OBJECT_BYTES, PackError, readPack } from "../src/lane-pack.js";

// Packs written by real `git pack-objects`, with OFS_DELTA and REF_DELTA objects, read back without Git.
function repoWith(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "octocove-lane-pack-"));
  const git = (args: string[], input?: string) => execFileSync("git", ["-C", repo, ...args], { input, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", "ignore"] });
  git(["init", "-q"]);
  for (const [path, content] of Object.entries(files)) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), content); }
  git(["add", "-A"]);
  const tree = git(["write-tree"]).toString().trim();
  const objects = git(["rev-list", "--objects", tree]).toString().split("\n").map((l) => l.split(" ")[0]!).filter(Boolean);
  return { repo, git, tree, objects, done: () => rmSync(repo, { recursive: true, force: true }) };
}
const similar = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`d${i % 3}/f${i}.txt`, Array.from({ length: 300 + i }, (_, n) => `line ${n}\n`).join("")]));

describe("lane packs", () => {
  for (const ofs of [true, false]) {
    it(`reads every object of a deltified pack (${ofs ? "OFS_DELTA" : "REF_DELTA"}) with its Git id and content`, () => {
      const r = repoWith({ ...similar, "empty.txt": "", "bin.dat": "\u0000\u0001ÿ".repeat(1000) });
      try {
        const pack = r.git(["pack-objects", "--stdout", "--window=20", "--depth=20", ...(ofs ? ["--delta-base-offset"] : [])], r.objects.join("\n") + "\n");
        const seen = new Map<string, Buffer>();
        expect(readPack(pack, (id, type, data) => { seen.set(id, data); expect(["tree", "blob"]).toContain(type); })).toEqual({ objects: r.objects.length });
        expect([...seen.keys()].sort()).toEqual([...r.objects].sort());
        for (const [path, content] of Object.entries(similar)) expect(seen.get(r.git(["hash-object", path]).toString().trim())!.toString()).toBe(content);
        // The pack really holds deltas.
        writeFileSync(join(r.repo, "p.pack"), pack);
        r.git(["index-pack", "p.pack"]);
        expect(r.git(["verify-pack", "-v", "p.idx"]).toString().split("\n").filter((l) => l.trim().split(/\s+/).length === 7).length).toBeGreaterThan(10);
      } finally { r.done(); }
    });
  }

  it("refuses a pack that ended early, a damaged trailer, or something that is not a pack", () => {
    const r = repoWith(similar);
    try {
      const pack = r.git(["pack-objects", "--stdout"], r.objects.join("\n") + "\n");
      expect(() => readPack(pack.subarray(0, pack.length - 1), () => {})).toThrow(PackError);
      const damaged = Buffer.from(pack); damaged[40] = damaged[40]! ^ 0xff;
      expect(() => readPack(damaged, () => {})).toThrow(/checksum/);
      expect(() => readPack(Buffer.from("<html>not a pack</html>".repeat(3)), () => {})).toThrow(/not a Git pack/);
    } finally { r.done(); }
  });

  it("applies copy and insert instructions, and refuses a delta that does not fit its base", () => {
    const base = Buffer.from("hello world");
    // src 11, dst 11; copy offset 0 len 6 ("hello "), insert "there".
    const delta = Buffer.from([11, 11, 0x91, 0, 6, 5, ...Buffer.from("there")]);
    expect(applyDelta(base, delta).toString()).toBe("hello there");
    expect(() => applyDelta(Buffer.from("short"), delta)).toThrow(PackError);
    expect(() => applyDelta(base, Buffer.from([11, 11, 0x91, 8, 6]))).toThrow(PackError);
  });

  // Hand-built packs with a valid checksum, so only the object itself is wrong.
  const header = (type: number, size: number) => { const out = [((type << 4) | (size & 15)) | (size > 15 ? 0x80 : 0)]; let rest = Math.floor(size / 16);
    while (rest) { out.push((rest & 0x7f) | (rest > 0x7f ? 0x80 : 0)); rest = Math.floor(rest / 128); } return Buffer.from(out); };
  const packOf = (...objects: Buffer[]) => { const head = Buffer.from([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, objects.length]); const body = Buffer.concat([head, ...objects]);
    return Buffer.concat([body, createHash("sha1").update(body).digest()]); };
  const varint = (n: number) => { const out: number[] = []; do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; };

  it("refuses hostile objects before allocating for them: a declared size past the limit, more output than declared, a delta building a huge object, a truncated header", () => {
    expect(() => readPack(packOf(header(3, MAX_OBJECT_BYTES + 1), deflateSync(Buffer.from("x"))), () => {})).toThrow(/larger than a lane may hold/);
    expect(() => readPack(packOf(header(3, 5), deflateSync(Buffer.alloc(100_000, 7))), () => {})).toThrow(PackError);
    const base = Buffer.from("base");
    const huge = Buffer.from([...varint(base.length), ...varint(2 ** 40), 0x91, 0, 4]);
    expect(() => applyDelta(base, huge)).toThrow(/larger than a lane may hold/);
    const ofs = Buffer.concat([header(6, huge.length), Buffer.from([0x10]), deflateSync(huge)]);
    expect(() => readPack(packOf(Buffer.concat([header(3, 4), deflateSync(base)]), ofs), () => {})).toThrow(PackError);
    expect(() => applyDelta(base, Buffer.from([0x84]))).toThrow(PackError);
    expect(() => readPack(packOf(Buffer.from([0xb3, 0x80])), () => {})).toThrow(PackError);
  });
});
