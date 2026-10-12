import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import { DurationShardSequencer } from "../duration-shard-sequencer";
import durations from "../test-durations.json";

const root = resolve(import.meta.dirname, "..");
const spec = (path: string) => ({ moduleId: resolve(root, path) }) as TestSpecification;
const files = Object.keys(durations).map(spec);
const sequencer = (index: number, count = 4) => new DurationShardSequencer({
  config: { root, shard: { index, count } },
} as Vitest);
const partition = async (input = files, count = 4) => Promise.all(
  Array.from({ length: count }, (_, i) => sequencer(i + 1, count).shard(input)),
);

describe("duration-based CI shards", () => {
  it("assigns every file exactly once regardless of discovery order", async () => {
    for (const count of [3, 4]) {
      const shards = await partition(files, count);
      expect(shards.flat().map(f => f.moduleId).sort()).toEqual(files.map(f => f.moduleId).sort());
      expect(await partition([...files].reverse(), count)).toEqual(shards);
    }
  });

  it("keeps measured two-worker makespans below eight minutes with longest files first", async () => {
    const measured: Record<string, number> = durations;
    const byId = new Map(files.map((f, i) => [f.moduleId, Object.values(measured)[i]]));
    const shards = await partition();
    const totals = shards.map(shard => shard.reduce((sum, file) => sum + byId.get(file.moduleId)!, 0));
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(3000);
    for (const shard of shards) {
      expect(await sequencer(1).sort([...shard].reverse())).toEqual(shard);
      const workers = [0, 0];
      for (const file of shard) workers[workers[0] <= workers[1] ? 0 : 1] += byId.get(file.moduleId)!;
      expect(Math.max(...workers)).toBeLessThan(480_000);
    }
  });

  it("includes newly discovered files with no historical timing", async () => {
    const unknown = spec("tests/new-unmeasured.test.ts");
    const input = [...files, unknown];
    const shards = await partition(input);
    expect(shards.flat()).toHaveLength(input.length);
    expect(shards.flat().filter(f => f.moduleId === unknown.moduleId)).toHaveLength(1);
    expect(await partition([...input].reverse())).toEqual(shards);
  });
});
