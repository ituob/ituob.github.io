import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, main, TARGETS, validateConfig, validateIsolation } from "../scripts/configure-cloudflare.mjs";

const templates = Object.fromEntries(Object.entries(TARGETS).map(([environment, target]) => [environment, JSON.parse(readFileSync(target.file, "utf8"))]));
const resources = (environment = "staging") => ({
  account_id: "1234567890abcdef1234567890abcdef",
  database_id: environment === "staging" ? "12345678-1234-1234-1234-123456789abc" : "87654321-4321-4321-4321-cba987654321",
  database_name: `ituob-${environment}`,
  notify_queue: `ituob-notify-${environment}`,
  dead_letter_queue: `ituob-notify-${environment}-dead`,
  vars: {
    OIDC_ISSUER: "https://identity.example.org", OIDC_CLIENT_ID: `ituob-${environment}`,
    ACCESS_TEAM_DOMAIN: "https://ituob-test.cloudflareaccess.com", ACCESS_AUD: `aud-${environment}`,
    MAIL_FROM: "ITU OB <notifications@example.org>", PATCH_REPO: "ituob/service-publications-docs",
    GITHUB_APP_ID: "12345", GITHUB_APP_INSTALLATION_ID: "67890", GITHUB_SITE_REPO: "ituob/ituob.github.io", GITHUB_DATA_GITLINK: "data-ob",
  } as Record<string, string>,
});
const build = (values = resources(), environment = "staging") => buildConfig(values, environment, templates[environment]);
let temp: string;
beforeEach(() => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
  temp = mkdtempSync(join(tmpdir(), "ituob-deployment-"));
  for (const [environment, target] of Object.entries(TARGETS)) writeFileSync(join(temp, target.file), JSON.stringify(templates[environment]));
});
afterEach(() => { rmSync(temp, { recursive: true, force: true }); vi.unstubAllEnvs(); });

describe("Cloudflare deployment configuration", () => {
  it("generates real binding shapes while preserving domains and assets", () => {
    const config = build();
    expect(config.d1_databases).toEqual([{ binding: "DB", database_name: "ituob-staging", database_id: resources().database_id, migrations_dir: "migrations" }]);
    expect(config.queues.producers).toEqual([{ binding: "NOTIFY_Q", queue: "ituob-notify-staging" }]);
    expect(config.queues.consumers[0]).toMatchObject({ queue: "ituob-notify-staging", dead_letter_queue: "ituob-notify-staging-dead", max_retries: 5 });
    expect(config.assets).toEqual(templates.staging.assets);
    expect(config.routes).toEqual(templates.staging.routes);
    expect(config.vars.OIDC_REDIRECT_URI).toBe("https://staging-www.ituob.org/auth/callback");
    expect(config.secrets.required).toEqual(["OIDC_CLIENT_SECRET", "RESEND_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]);
    expect(validateConfig(config, "staging")).toBe(config);
    expect(build(resources("production"), "production").routes).toEqual(templates.production.routes);
  });
  it("does not change files on a dry run; --write changes only the selected config", () => {
    const input = join(temp, "resources.json");
    writeFileSync(input, JSON.stringify({ staging: resources() }));
    const stagingBefore = readFileSync(join(temp, TARGETS.staging.file), "utf8");
    const productionBefore = readFileSync(join(temp, TARGETS.production.file), "utf8");
    const output = main(["--input", input, "--environment", "staging"], temp);
    expect(JSON.parse(output).d1_databases[0].database_id).toBe(resources().database_id);
    expect(readFileSync(join(temp, TARGETS.staging.file), "utf8")).toBe(stagingBefore);
    main(["--input", input, "--environment", "staging", "--write"], temp);
    expect(readFileSync(join(temp, TARGETS.staging.file), "utf8")).toBe(output);
    expect(readFileSync(join(temp, TARGETS.production.file), "utf8")).toBe(productionBefore);
    expect(main(["--check", "--environment", "staging"], temp)).toContain("Remote resources, migrations and secret values are not checked");
  });
  it("preserves deployment authentication without exposing provider secrets", () => {
    for (const config of Object.values(templates)) {
      expect(config.vars.AUTH_MODE).toBe("oidc");
      expect(JSON.stringify(config)).not.toMatch(/stub/i);
      for (const name of ["OIDC_CLIENT_SECRET", "RESEND_API_KEY", "GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"]) {
        expect(config.vars).not.toHaveProperty(name);
        expect(config.secrets.required).toContain(name);
      }
    }
  });
  it("refuses resource-free checked-in templates instead of claiming deployment readiness", () => {
    for (const environment of ["staging", "production"]) expect(() => validateConfig(templates[environment], environment)).toThrow(/account_id/);
  });
  it.each(["account_id", "database_id", "database_name", "notify_queue", "dead_letter_queue"])("rejects missing/invalid %s", (field) => {
    const values = resources() as any;
    delete values[field];
    expect(() => build(values)).toThrow();
    values[field] = "<unconfigured>";
    expect(() => build(values)).toThrow();
  });
  it("rejects missing required vars, local endpoints and environment callback mismatches", () => {
    const values = resources();
    delete values.vars.OIDC_ISSUER;
    expect(() => build(values)).toThrow(/OIDC_ISSUER/);
    values.vars.OIDC_ISSUER = "http://localhost:3000";
    expect(() => build(values)).toThrow(/HTTPS/);
    values.vars.OIDC_ISSUER = "https://identity.example.org";
    values.vars.OIDC_REDIRECT_URI = "https://www.ituob.org/auth/callback";
    expect(() => build(values)).toThrow(/callback/);
  });
  it("never accepts development auth or secret values in the manifest", () => {
    const values = resources();
    values.vars.AUTH_MODE = "stub";
    expect(() => build(values)).toThrow(/AUTH_MODE/);
    values.vars.AUTH_MODE = "oidc";
    values.vars.RESEND_API_KEY = "do-not-print-this-secret";
    expect(() => build(values)).toThrow(/unsupported key or a secret/);
    try { build(values); } catch (error) { expect(String(error)).not.toContain("do-not-print-this-secret"); }
  });
  it("handles explicitly configured public OIDC clients without requiring a client secret", () => {
    const values = resources();
    values.vars.OIDC_CLIENT_AUTH = "none";
    expect(build(values).secrets.required).not.toContain("OIDC_CLIENT_SECRET");
    values.vars.OIDC_CLIENT_AUTH = "post";
    expect(build(values).secrets.required).toContain("OIDC_CLIENT_SECRET");
  });
  it("rejects provider repository/gitlink mismatch and missing provider secrets", () => {
    const values = resources();
    values.vars.GITHUB_DATA_GITLINK = "data";
    expect(() => build(values)).toThrow(/PATCH_REPO/);
    values.vars.PATCH_REPO = "ituob/itu-ob-data";
    expect(build(values).vars.GITHUB_DATA_GITLINK).toBe("data");
    const config = build();
    config.secrets.required = ["OIDC_CLIENT_SECRET"];
    expect(() => validateConfig(config, "staging")).toThrow(/secret names/);
  });
  it("rejects queue mismatch, missing DB and incorrectly positioned Worker-first routing", () => {
    let config = build(); config.queues.consumers[0].queue = "different";
    expect(() => validateConfig(config, "staging")).toThrow(/consumer/);
    config = build(); config.d1_databases = [];
    expect(() => validateConfig(config, "staging")).toThrow(/D1/);
    config = build(); config.run_worker_first = true; delete config.assets.run_worker_first;
    expect(() => validateConfig(config, "staging")).toThrow(/inside assets/);
  });
  it("refuses shared staging/production data, queues and Access audiences", () => {
    const staging = build(), production = build(resources("production"), "production");
    expect(() => validateIsolation(staging, production)).not.toThrow();
    production.d1_databases[0].database_id = staging.d1_databases[0].database_id;
    expect(() => validateIsolation(staging, production)).toThrow(/D1/);
    production.d1_databases[0].database_id = resources("production").database_id;
    production.queues.consumers[0].dead_letter_queue = staging.queues.producers[0].queue;
    expect(() => validateIsolation(staging, production)).toThrow(/queues/);
    production.queues.consumers[0].dead_letter_queue = resources("production").dead_letter_queue;
    production.vars.ACCESS_AUD = staging.vars.ACCESS_AUD;
    expect(() => validateIsolation(staging, production)).toThrow(/audiences/);
  });
  it("checks CI account identity and refuses ambiguous command combinations", () => {
    expect(() => validateConfig(build(), "staging", "ffffffffffffffffffffffffffffffff")).toThrow(/differs/);
    expect(() => main(["--environment", "dev", "--check"], temp)).toThrow(/staging or production/);
    expect(() => main(["--environment", "staging", "--check", "--write"], temp)).toThrow(/cannot be combined/);
    expect(() => main(["--environment", "staging", "--unknown"], temp)).toThrow(/Usage/);
  });
});
