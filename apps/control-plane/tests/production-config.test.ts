import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain Node script without type declarations
import { productionConfig, stripComments } from "../scripts/production-config.mjs";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "wrangler.jsonc"), "utf8");
const local = JSON.parse(stripComments(source));
const databaseId = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const generate = (id?: string) =>
  productionConfig(source, { databaseId: id, configDir: root, outDir: resolve(root, "dist") });

describe.sequential("production wrangler config", () => {
  it("rejects a missing, placeholder or malformed D1 id", () => {
    expect(() => generate()).toThrow(/empty/);
    expect(() => generate("  ")).toThrow(/empty/);
    expect(() => generate(local.d1_databases[0].database_id)).toThrow(/placeholder/);
    expect(() => generate("octocove")).toThrow(/UUID/);
  });

  it("binds the production D1 id and keeps the migrations directory", () => {
    const [db] = generate(databaseId).d1_databases;
    expect(db).toEqual({ ...local.d1_databases[0], database_id: databaseId, migrations_dir: "../migrations" });
  });

  it("removes the unused artifacts binding", () => {
    expect(local.artifacts).toBeDefined();
    expect(generate(databaseId)).not.toHaveProperty("artifacts");
  });

  it("serves the api.octocove.com custom domain and only the auth callback, CLI start and CLI confirm on the web host", () => {
    const config = generate(databaseId);
    expect(config.routes).toEqual([
      { pattern: "api.octocove.com", custom_domain: true },
      { pattern: "app.octocove.com/auth/callback*", zone_name: "octocove.com" },
      { pattern: "app.octocove.com/auth/cli/start*", zone_name: "octocove.com" },
      { pattern: "app.octocove.com/v1/auth/cli/confirm*", zone_name: "octocove.com" },
    ]);
    expect(config.workers_dev).toBe(false);
    expect(config.main).toBe("../src/index.ts");
  });

  it("commits only non-secret vars and never the dev-local switch", () => {
    expect(generate(databaseId).vars).toEqual({
      AUTH_ALLOWED_ORIGINS: "https://app.octocove.com",
      OCTOCOVE_ISSUER: "https://api.octocove.com",
      OIDC_REDIRECT_URI: "https://app.octocove.com/auth/callback",
      PROJECT_CREATE_MAX_PER_CREATOR: "20",
    });
  });

  it("sets the OIDC redirect URI to the registered web-host callback that a route serves", () => {
    const config = generate(databaseId);
    expect(config.vars.OIDC_REDIRECT_URI).toBe("https://app.octocove.com/auth/callback");
    const { host, pathname } = new URL(config.vars.OIDC_REDIRECT_URI);
    expect(config.routes).toContainEqual({ pattern: `${host}${pathname}*`, zone_name: "octocove.com" });
    // The CLI's verificationUrl resolves /auth/cli/start against the redirect URI, so it needs the same host.
    expect(config.routes).toContainEqual({ pattern: `${host}/auth/cli/start*`, zone_name: "octocove.com" });
    // The CLI callback's confirmEndpoint resolves against the callback's host, where its cookies are.
    expect(config.routes).toContainEqual({ pattern: `${host}/v1/auth/cli/confirm*`, zone_name: "octocove.com" });
  });

  it("copies Durable Objects, DO migrations, queues, cron and compatibility verbatim", () => {
    const config = generate(databaseId);
    for (const key of ["name", "compatibility_date", "durable_objects", "migrations", "queues", "triggers"])
      expect(config[key], key).toEqual(local[key]);
    expect(config.migrations.map((m: { tag: string }) => m.tag))
      .toEqual(["v1-task-coordinator", "v2-remote-sweeper", "v3-webhook-dispatcher"]);
    const known = ["name", "main", "compatibility_date", "compatibility_flags", "d1_databases", "durable_objects",
      "migrations", "queues", "triggers", "artifacts", "routes", "workers_dev", "vars"];
    // A new top-level key in wrangler.jsonc must be reviewed for production here.
    expect(Object.keys(local).filter((key) => !known.includes(key))).toEqual([]);
  });

  it("strips comments without touching strings", () => {
    expect(JSON.parse(stripComments('{"a": "x//y", /* b */ "c": "/*z*/" // d\n}'))).toEqual({ a: "x//y", c: "/*z*/" });
  });
});
