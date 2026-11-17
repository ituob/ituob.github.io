import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { parseRegisters } from "../src/lib/form/catalog-yaml.ts";
import { RECOMMENDATIONS_YAML, REGISTERS_YAML } from "./fixtures/catalog.ts";
import { activateMember, api, provisionItu, seedFixtures } from "./helpers.ts";

const EDITOR = "itu-editor@example.test", MEMBER = "member-A@example.test", NOBODY = "unaffiliated@example.test";
const base = "/api/admin/catalog";
const entry = { id: "BUREAUFAX2", title: { en: "Bureaufax" }, url: "https://www.itu.int/pub/bf", recommendation: "E.164", key_field: "number" };
let fake: FakePatchPublisher;
const create = (body: unknown, access = EDITOR) => api("POST", `${base}/registers`, { access, body });
const edit = (id: string, body: unknown, access = EDITOR) => api("PUT", `${base}/registers/${encodeURIComponent(id)}`, { access, body });

beforeEach(async () => {
  await seedFixtures(); await provisionItu("itu-editor", ["itu-editor"]);
  fake = new FakePatchPublisher(); fake.catalogFiles = { registers: REGISTERS_YAML, recommendations: RECOMMENDATIONS_YAML }; setPublisher(fake);
});
afterEach(() => setPublisher(null));

describe("catalog entry routes", () => {
  it("refuses members, unaffiliated users and session-only callers with 403 and opens nothing", async () => {
    await activateMember("member-A", "A");
    for (const who of [MEMBER, NOBODY]) {
      expect((await api("GET", base, { access: who })).status).toBe(403);
      expect((await create(entry, who)).status).toBe(403);
      expect((await edit("DP", { id: "DP", title: { en: "x" }, recommendation: "E.164" }, who)).status).toBe(403);
    }
    expect((await api("POST", `${base}/registers`, { session: "member-A", body: entry })).status).toBe(403);
    expect((await api("GET", base)).status).toBe(403);
    expect(fake.catalogRequests).toEqual([]);
  });

  it("lists registers and recommendations for staff", async () => {
    const res = await api("GET", base, { access: EDITOR });
    expect(res.status).toBe(200);
    expect(res.json.registers.map((r: any) => r.id)).toEqual(["E118_IIN", "DP", "List of Coast Stations"]);
    expect(res.json.recommendations.map((r: any) => r.code)).toEqual(["E.118", "E.164", "RR.25.1"]);
  });

  it("creates a register by opening one review PR that changes only registers.yaml", async () => {
    const res = await create(entry);
    expect(res.status).toBe(202);
    expect(res.json.pr.url).toMatch(/pull\/1$/);
    expect(fake.catalogRequests).toHaveLength(1);
    const sent = fake.catalogRequests[0]!;
    expect(sent).toMatchObject({ path: "catalogs/registers.yaml", repo: "ituob/service-publications-docs" });
    expect(sent.branch).toMatch(/^rt-cat-[0-9a-f]{12}$/);
    expect(parseRegisters(sent.content).at(-1)).toMatchObject({ register_id: "BUREAUFAX2", classification: "textual", url: entry.url });
    expect(parseRegisters(sent.content).slice(0, 3)).toEqual(parseRegisters(REGISTERS_YAML));
    // A retry of the same request reuses the branch and the PR.
    const again = await create(entry);
    expect(again.json.pr).toEqual(res.json.pr);
    expect(fake.createdPrs).toBe(0);
  });

  it("refuses a duplicate id with 409", async () => {
    for (const id of ["DP", "dp", "E118_IIN"]) {
      const res = await create({ ...entry, id });
      expect([409, 422], id).toContain(res.status);
    }
    expect((await create({ ...entry, id: "DP" })).status).toBe(409);
    expect(fake.catalogRequests).toEqual([]);
  });

  it("refuses a lowercase id, a bad URL, an unknown recommendation and a missing title with 422", async () => {
    for (const bad of [{ id: "bureaufax" }, { url: "not a url" }, { url: "javascript:alert(1)" }, { recommendation: "Z.999" }, { title: { fr: "Titre" } }, { key_field: "" }]) {
      const res = await create({ ...entry, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(res.json.errors.length).toBeGreaterThan(0);
    }
    expect((await create({ ...entry, id: 5 })).status).toBe(400);
    expect(fake.catalogRequests).toEqual([]);
  });

  it("edits title, url and recommendation but refuses an id change", async () => {
    const changed = await edit("DP", { id: "DP", title: { en: "Dialling", fr: "Numerotation" }, url: "https://www.itu.int/dp", recommendation: "E.118" });
    expect(changed.status).toBe(202);
    const row = parseRegisters(fake.catalogRequests[0]!.content)[1]!;
    expect(row).toMatchObject({ register_id: "DP", recommendation: "E.118", url: "https://www.itu.int/dp", key_field: "country_code" });
    const renamed = await edit("DP", { id: "DP2", title: { en: "x" }, recommendation: "E.164" });
    expect(renamed.status).toBe(422);
    expect(renamed.json.errors).toEqual([expect.objectContaining({ path: "id", code: "mismatch" })]);
    expect((await edit("NOPE", { id: "NOPE", title: { en: "x" }, recommendation: "E.164" })).status).toBe(404);
    expect(fake.catalogRequests).toHaveLength(1);
  });

  it("reports an upstream failure as 502 and a moved catalog as 409", async () => {
    fake.failNext = 1;
    expect((await create(entry)).status).toBe(502);
    const moved = new FakePatchPublisher(); moved.catalogFiles = fake.catalogFiles;
    const read = moved.readCatalog.bind(moved);
    moved.readCatalog = async (r) => { const s = await read(r); moved.catalogFiles = { ...moved.catalogFiles, registers: `${moved.catalogFiles.registers}\n# moved\n` }; return s; };
    setPublisher(moved);
    expect((await create(entry)).status).toBe(409);
  });
});
