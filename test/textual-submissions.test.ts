import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PUBLICATIONS } from "../src/lib/catalogs.ts";
import { FakePatchPublisher, setPublisher } from "../worker/lib/publisher.ts";
import { activateMember, api, db, provisionItu, seedFixtures } from "./helpers.ts";

const textual = PUBLICATIONS.filter((p) => p.classification === "textual");
const textPayload = (id = "NNP", text = "National numbering plan update") => ({
  type: "ADD", data: { _class: "TextAmendment", dataset_code: id, text },
});
const textBody = (id = "NNP", slug = "nnp", payload: unknown = textPayload(id)) => ({
  register_id: id, slug, action_type: "ADD", payload,
});
const count = async (table: string) => (await db().prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const post = (id: string, move: string, session = "itu-editor", body = {}) =>
  api("POST", `/api/me/submissions/${id}/${move}`, { session, body });
const review = (id: string, move: string, body = {}) =>
  api("POST", `/api/admin/submissions/${id}/${move}`, { access: "itu-admin@example.test", body });
let publisher: FakePatchPublisher;
beforeEach(async () => {
  await seedFixtures();
  await activateMember("member-A", "A");
  await activateMember("member-B", "B");
  await provisionItu("itu-editor", ["itu-editor"]);
  await provisionItu("itu-admin", ["itu-admin"]);
  publisher = new FakePatchPublisher();
  setPublisher(publisher);
});
afterEach(() => setPublisher(null));

describe("catalog text submissions", () => {
  it.each(textual)("accepts the canonical ID and slug for $slug, including spaces and periods", async (publication) => {
    const draft = await api("POST", "/api/me/submissions", {
      session: "itu-editor", body: textBody(publication.publicationId, publication.slug),
    });
    expect(draft.status).toBe(201);
    expect((await post(draft.json.submission.id, "submit")).status).toBe(200);
  });

  it("saves errors in drafts; validates edits/revisions, then opens a PR with the generated-schema text payload", async () => {
    const draft = await api("POST", "/api/me/submissions", { session: "itu-editor", body: textBody("NNP", "nnp", textPayload("NNP", " ")) });
    expect(draft.status).toBe(201);
    const id = draft.json.submission.id as string;
    expect((await post(id, "submit")).json.errors).toContainEqual(expect.objectContaining({ path: "data.text", code: "required" }));
    expect((await api("PUT", `/api/me/submissions/${id}`, { session: "itu-editor", body: { payload: textPayload() } })).status).toBe(200);
    expect((await post(id, "submit")).status).toBe(200);
    expect((await review(id, "start-review")).status).toBe(200);
    expect((await review(id, "request-changes", { reason: "Clarify the text" })).status).toBe(200);
    const before = await count("submission_revisions");
    const bad = await post(id, "revise", "itu-editor", { payload: textPayload("E212_ICC") });
    expect(bad.status).toBe(422);
    expect(bad.json.errors).toContainEqual(expect.objectContaining({ path: "data.dataset_code", code: "mismatch" }));
    expect(await count("submission_revisions")).toBe(before);
    expect((await post(id, "revise", "itu-editor", { payload: textPayload("NNP", "Revised national numbering plan") })).status).toBe(200);
    expect((await review(id, "start-review")).status).toBe(200);
    expect((await review(id, "approve", { target_edition: 1351 })).status).toBe(200);
    expect(publisher.requests).toHaveLength(1);
    expect(publisher.requests[0]!.path).toBe("ob-issues/1351/nnp/001-ADD.yaml");
    expect(parse(publisher.requests[0]!.content).data).toEqual(textPayload("NNP", "Revised national numbering plan").data);
  });

  it("rejects unknown IDs and mismatched canonical slugs before writing", async () => {
    for (const body of [textBody("UNKNOWN", "unknown"), textBody("NNP", "e118-iin"), textBody("NNP", "../nnp")]) {
      const response = await api("POST", "/api/me/submissions", { session: "itu-editor", body });
      expect(response.status).toBe(422);
      expect(response.json.errors).toEqual([expect.objectContaining({ path: body.register_id === "UNKNOWN" ? "register_id" : "slug" })]);
    }
    expect(await count("submissions")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("rejects unknown classes, text on structured registers, and smuggled country entries at submit", async () => {
    for (const body of [
      textBody("NNP", "nnp", { type: "ADD", data: { _class: "UnknownAmendment", text: "Other country" } }),
      textBody("E118_IIN", "e118-iin"),
      textBody("NNP", "nnp", { ...textPayload(), data: { ...textPayload().data, entries: [{ country_or_area: { en: "Aland" } }] } }),
    ]) {
      const draft = await api("POST", "/api/me/submissions", { session: "itu-editor", body });
      expect(draft.status).toBe(201);
      const id = draft.json.submission.id;
      expect((await post(id, "submit")).status).toBe(422);
      expect((await db().prepare("SELECT state FROM submissions WHERE id=?1").bind(id).first<any>()).state).toBe("draft");
    }
  });
});

describe("text has no verifiable member country scope", () => {
  it("country-bound members cannot choose TextAmendment or add spoofed country entries", async () => {
    for (const body of [
      textBody(), textBody("RR.25.1", "rr251"), textBody("E118_IIN", "e118-iin"),
      textBody("NNP", "nnp", { ...textPayload(), data: { ...textPayload().data, entries: [{ country_or_area: { en: "Aland" } }] } }),
    ]) {
      const response = await api("POST", "/api/me/submissions", { session: "member-A", body });
      expect(response.status).toBe(422);
      expect(response.json.errors).toEqual([expect.objectContaining({ path: "data", message: expect.stringContaining("country scope cannot be verified") })]);
    }
    expect(await count("submissions")).toBe(0);
    expect(await count("audit_log")).toBe(0);
  });

  it("cannot replace a bound typed draft with text at edit or revise", async () => {
    const payload = { type: "ADD", data: { _class: "NNPAmendment", entries: [{ country_or_area: { en: "Aland" } }] } };
    const created = await api("POST", "/api/me/submissions", { session: "member-A", body: textBody("NNP", "nnp", payload) });
    expect(created.status).toBe(201);
    const id = created.json.submission.id;
    expect((await api("PUT", `/api/me/submissions/${id}`, { session: "member-A", body: { payload: textPayload() } })).status).toBe(422);
    expect((await post(id, "submit", "member-A")).status).toBe(200);
    expect((await review(id, "start-review")).status).toBe(200);
    expect((await review(id, "request-changes", { reason: "Clarify" })).status).toBe(200);
    const before = await count("submission_revisions");
    expect((await post(id, "revise", "member-A", { payload: textPayload() })).status).toBe(422);
    expect(await count("submission_revisions")).toBe(before);
  });

  it.each([
    ["NNP", "nnp", "NNPAmendment", "country_or_area"],
    ["RR.25.1", "rr251", "RR251Amendment", "country_or_area"],
    ["R_SP_LN.VIII", "list-viii", "ListVIIIAmendment", "country"],
  ])("retains specialized %s country binding and rejects foreign/mixed countries", async (id, slug, cls, field) => {
    const entry = (country: string) => ({ [field!]: field === "country" ? country : { en: country } });
    for (const entries of [[entry("Bland")], [entry("Aland"), entry("Bland")]]) {
      const refused = await api("POST", "/api/me/submissions", { session: "member-A", body: textBody(id, slug, { type: "ADD", data: { _class: cls, entries } }) });
      expect(refused.status).toBe(403);
    }
    expect(await count("submissions")).toBe(0);
    const created = await api("POST", "/api/me/submissions", { session: "member-A", body: textBody(id, slug, { type: "ADD", data: { _class: cls, entries: [entry("Aland")] } }) });
    expect(created.status).toBe(201);
    expect((await post(created.json.submission.id, "submit", "member-A")).status).toBe(200);
  });
});
