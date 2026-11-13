import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { schemaStage, validate } from "../worker/lib/validation.ts";
import { AMENDMENT_CLASSES, CLASSES, ENUMS, validateClass } from "../src/lib/schema.validators.generated.ts";
import corpus from "./fixtures/corpus-sample.json";
import { activateMember, api, db, seedFixtures } from "./helpers.ts";

// The Worker validates a submitted register change against validators GENERATED
// from the ontology the Ruby gem compiles (messages.lml). The full-corpus proof
// lives in service-publications-docs (ts_validators_spec.rb, every stored file);
// here a sample of stored ob-issues action files (every register x action type:
// first, last and a mid-sized one) must be accepted and crafted inputs rejected.

type Stored = { id: string; file: Record<string, any> };
const sample = corpus as Stored[];

const codes = (errs: { path: string; code: string }[]) => errs.map((e) => `${e.code}:${e.path}`).sort();

describe("generated validators: stored corpus instances", () => {
  it("the sample covers the keyed registers and every action type", () => {
    expect(sample.length).toBeGreaterThan(80);
    expect(new Set(sample.map((s) => s.id.split("/")[1]))).toEqual(
      new Set(["dp", "e118-iin", "e164-acn", "e164-cc", "e212-mnc", "f32-tdi", "f400-admd", "list-viii", "m1400-icc", "nnp", "q708-ispc", "q708-sanc", "t35-na", "x121-dnic", "e218-trcc"].filter((slug) => sample.some((s) => s.id.split("/")[1] === slug))),
    );
    expect(new Set(sample.map((s) => s.file.type))).toEqual(new Set(["ADD", "SUP", "REP", "LIR", "MOD"]));
  });

  it.each(sample.map((s) => [s.id, s] as const))("accepts the stored action file %s", (_id, s) => {
    expect(validateClass("RegisterChange", s.file)).toEqual([]);
    expect(AMENDMENT_CLASSES).toContain(s.file.data._class);
    expect(validateClass(s.file.data._class, s.file.data, "data")).toEqual([]);
    // The member-authored part (what the Worker stores) passes the schema stage whole.
    const payload = { type: s.file.type, data: s.file.data };
    expect(schemaStage({ register_id: "X", action_type: s.file.type, payload })).toEqual([]);
  });
});

describe("generated validators: crafted bad inputs", () => {
  const entry = { country_or_area: { en: "Aland" }, company_name: "Acme", tel: ["+358 1"], issue_id_number: "89 358 01" };
  const good = () => ({ type: "ADD", data: { _class: "E118Amendment", entries: [{ ...entry }], notes: [] } });
  const run = (mut: (p: any) => void) => {
    const p = good();
    mut(p);
    return codes(schemaStage({ register_id: "E118_IIN", action_type: "ADD", payload: p }));
  };

  it("accepts the control payload", () => expect(run(() => {})).toEqual([]));
  it("rejects an unknown envelope key", () => expect(run((p) => (p.bogus = 1))).toEqual(["unknown:bogus"]));
  it("rejects an enum value outside ActionType", () => expect(run((p) => (p.type = "YOLO"))).toEqual(["enum:type"]));
  it("rejects a non-object data", () => expect(run((p) => (p.data = "text"))).toEqual(["type:data"]));
  it("rejects a data._class that is not an amendment class", () => expect(run((p) => (p.data._class = "E118Entry"))).toEqual(["enum:data._class"]));
  it("rejects an unknown amendment key", () => expect(run((p) => (p.data.company = "x"))).toEqual(["unknown:data.company"]));
  it("rejects a wrong scalar type inside an entry", () => expect(run((p) => (p.data.entries[0].company_name = 7))).toEqual(["type:data.entries[0].company_name"]));
  it("rejects a scalar where a collection is declared", () => expect(run((p) => (p.data.entries[0].tel = "+358 1"))).toEqual(["type:data.entries[0].tel"]));
  it("rejects a wrong item inside a collection", () => expect(run((p) => (p.data.notes = ["ok", 3]))).toEqual(["type:data.notes[1]"]));
  it("rejects entries that are not a list", () => expect(run((p) => (p.data.entries = entry))).toEqual(["type:data.entries"]));
  it("rejects a plain string for the multilingual country (the stored shape is {en: ...})", () =>
    expect(run((p) => (p.data.entries[0].country_or_area = "Aland"))).toEqual(["type:data.entries[0].country_or_area"]));
  it("rejects a non-string multilingual value", () => expect(run((p) => (p.data.entries[0].country_or_area = { en: 1 }))).toEqual(["type:data.entries[0].country_or_area.en"]));
  it("rejects a malformed Date attribute", () => expect(run((p) => (p.data.position_on = "next tuesday"))).toEqual(["type:data.position_on"]));
  it("rejects an unknown key nested in an entry", () => expect(run((p) => (p.data.entries[0].superseded_by = { x: 1 }))).toEqual(["unknown:data.entries[0].superseded_by"]));
  it("does not demand the server-assigned identifier from the member", () => expect(run((p) => delete p.identifier)).toEqual([]));
  it("still requires the envelope identifier when the ontology marks it required and one is sent malformed", () => expect(run((p) => (p.identifier = "x"))).toEqual(["type:identifier"]));

  it("the value kinds: Hash is an object, HashOrText object-or-string, DateOrText a string", () => {
    expect(codes(validateClass("IssueMetadata", { languages: "en" }))).toEqual(["type:languages"]);
    expect(validateClass("IssueMetadata", { languages: { en: "English" } })).toEqual([]);
    expect(validateClass("IssueMetadata", { publication_date: "see note" })).toEqual([]);
    expect(codes(validateClass("IssueMetadata", { publication_date: 20240101 }))).toEqual(["type:publication_date"]);
    expect(validateClass("GeneralMiscCommunications", { contents: "free" })).toEqual([]);
    expect(validateClass("GeneralMiscCommunications", { contents: { a: 1 } })).toEqual([]);
    expect(codes(validateClass("GeneralMiscCommunications", { contents: 5 }))).toEqual(["type:contents"]);
  });

  it("is generated from the ontology: ActionType members and the required identifier are present", () => {
    expect(ENUMS.ActionType).toEqual(["ADD", "SUP", "REP", "LIR", "MOD", "DEL", "SEED"]);
    expect(CLASSES.RegisterChange.identifier).toMatchObject({ kind: "class", ref: "Identifier", required: true });
    expect(codes(validateClass("RegisterChange", { type: "ADD" }))).toEqual(["required:identifier"]);
  });
});

describe("the Worker submission path calls the generated validators", () => {
  let fake: FakePatchPublisher;
  beforeEach(async () => {
    await seedFixtures();
    await activateMember("member-A", "A");
    fake = new FakePatchPublisher();
    setPublisher(fake);
  });
  afterEach(() => setPublisher(null));

  const body = (payload: unknown) => ({ register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD", payload });
  const entry = { country_or_area: { en: "Aland" }, company_name: "Acme Telecom" };
  const mkDraft = async (payload: unknown) => {
    const r = await api("POST", "/api/me/submissions", { session: "member-A", body: body(payload) });
    expect(r.status).toBe(201);
    return r.json.submission.id as string;
  };

  it("the default validator chain reports ontology errors", () => {
    const errs = validate({ register_id: "E118_IIN", action_type: "ADD", payload: { type: "ADD", data: { _class: "E118Amendment", entries: [{ ...entry, tel: "x" }] } } });
    expect(codes(errs)).toEqual(["type:data.entries[0].tel"]);
  });

  it("rejects ontology errors at create with field pointers and no partial durable writes", async () => {
    const tables = ["submissions", "submission_revisions", "review_state", "audit_log"];
    const snapshot = () => Promise.all(tables.map(table => db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().then(r => r.results)));
    const before = await snapshot();
    const r = await api("POST", "/api/me/submissions", { session: "member-A", body: body({ type: "ADD", data: { _class: "E118Amendment", entries: [{ ...entry, company_name: 7, tel: "x", extra: true }] } }) });
    expect(r.status).toBe(422);
    expect(codes(r.json.errors)).toEqual(["type:data.entries[0].company_name", "type:data.entries[0].tel", "unknown:data.entries[0].extra"]);
    expect(await snapshot()).toEqual(before);
  });

  it("a payload in the stored corpus shape submits", async () => {
    const stored = sample.find((s) => s.id.includes("e118-iin") && s.file.type === "ADD")!;
    const e = { ...stored.file.data.entries[0], country_or_area: { en: "Aland" } };
    const id = await mkDraft({ type: "ADD", data: { ...stored.file.data, entries: [e] } });
    const r = await api("POST", `/api/me/submissions/${id}/submit`, { session: "member-A", body: {} });
    expect(r.status).toBe(200);
  });
});
