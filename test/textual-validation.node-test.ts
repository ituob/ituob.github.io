import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_TYPES, validate, registerKeysOf } from "../worker/lib/validation.ts";
import { validateClass } from "../src/lib/schema.validators.generated.ts";
import { PUBLICATIONS } from "../src/lib/catalogs.ts";

const text = (id = "NNP", extra = {}) => ({ type: "ADD", data: {
  _class: "TextAmendment", dataset_code: id, text: "National numbering plan update", ...extra,
} });
const errors = (payload: unknown, register_id = "NNP") => validate({ register_id, action_type: "ADD", payload });
const codes = (payload: unknown, id = "NNP") => errors(payload, id).map((e) => `${e.code}:${e.path}`);

test("catalog textual publications accept ontology TextAmendment with no invented entries", () => {
  for (const publication of PUBLICATIONS.filter((p) => p.classification === "textual")) {
    const payload = text(publication.publicationId);
    assert.deepEqual(validateClass("TextAmendment", payload.data), []);
    for (const action_type of ACTION_TYPES)
      assert.deepEqual(validate({ register_id: publication.publicationId, action_type, payload: { ...payload, type: action_type } }), [], `${publication.publicationId}/${action_type}`);
    assert.deepEqual(registerKeysOf(publication.publicationId, payload), []);
  }
});

test("textual exemption cannot be used for unknown or structured registers", () => {
  assert.ok(codes(text("UNKNOWN"), "UNKNOWN").includes("unknown:register_id"));
  assert.ok(codes(text("E118_IIN"), "E118_IIN").includes("mismatch:data._class"));
  assert.ok(codes(text("E212_ICC")).includes("mismatch:data.dataset_code"));
});

test("text amendments require actual text and canonical dataset binding", () => {
  assert.ok(codes(text("NNP", { text: "  " })).includes("required:data.text"));
  assert.ok(codes(text("NNP", { dataset_code: undefined })).includes("required:data.dataset_code"));
  assert.ok(codes(text("NNP", { text: 42 })).includes("type:data.text"));
});

test("text amendments retain generated nested/unknown-field and envelope validation", () => {
  assert.deepEqual(errors(text("NNP", { actions: [{ action_type: "ADD", position: "P 7" }] })), []);
  assert.ok(codes(text("NNP", { actions: [{ action_type: 7 }] })).includes("type:data.actions[0].action_type"));
  assert.ok(codes(text("NNP", { actions: [{ position: { en: "P 7" } }] })).includes("type:data.actions[0].position"));
  assert.ok(codes(text("NNP", { entries: [{ country_or_area: { en: "Aland" } }] })).includes("unknown:data.entries"));
  assert.ok(codes(text("NNP", { arbitrary: true })).includes("unknown:data.arbitrary"));
  assert.ok(codes(text("NNP", { _class: "UnknownAmendment" })).includes("enum:data._class"));
  assert.ok(codes({ ...text(), type: "DEL" }).includes("mismatch:type"));
});

test("structured ADD/SUP retain entry presence, company, schema and country requirements", () => {
  for (const action_type of ["ADD", "SUP"] as const) {
    const payload = { type: action_type, data: { _class: "E118Amendment", entries: [
      { country_or_area: { en: "Aland" }, company_name: "Acme Telecom" },
    ] } };
    assert.deepEqual(validate({ register_id: "E118_IIN", action_type, payload }), []);
    assert.deepEqual(registerKeysOf("E118_IIN", payload), ["Aland"]);
    assert.ok(validate({ register_id: "E118_IIN", action_type, payload: { type: action_type, data: { _class: "E118Amendment" } } }).some((e) => e.path === "data.entries"));
  }
  assert.ok(errors({ type: "ADD", data: { _class: "E118Amendment", entries: [{ company_name: "Acme" }] } }, "E118_IIN").some((e) => e.path === "data.entries[0].country_or_area"));
});

test("specialized NNP/RR251/ListVIII entry schemas and country binding remain usable", () => {
  for (const [id, cls, entry] of [
    ["NNP", "NNPAmendment", { country_or_area: { en: "Aland" } }],
    ["RR.25.1", "RR251Amendment", { country_or_area: { en: "Aland" } }],
    ["R_SP_LN.VIII", "ListVIIIAmendment", { country: "Aland", name: "Station" }],
  ] as const) {
    const payload = { type: "ADD", data: { _class: cls, entries: [entry] } };
    assert.deepEqual(validateClass(cls, payload.data), []);
    assert.deepEqual(errors(payload, id), [], id);
    assert.deepEqual(registerKeysOf(id, payload), ["Aland"], id);
  }
});

test("every submission target uses exact catalog ID and slug, not sanitized user input", async () => {
  const { submissionTargetErrors } = await import("../worker/lib/validation.ts");
  for (const publication of PUBLICATIONS) assert.deepEqual(submissionTargetErrors(publication.publicationId, publication.slug), []);
  assert.equal(submissionTargetErrors("NNP", "../nnp")[0]?.path, "slug");
  assert.equal(submissionTargetErrors("NNP", "e118-iin")[0]?.path, "slug");
  assert.equal(submissionTargetErrors("RANDOM", "random")[0]?.path, "register_id");
});

test("actual submission write path denies unscoped member text before any database access", async () => {
  const { createSubmission, ValidationFailed } = await import("../worker/lib/submissions.ts");
  const noDatabaseAccess = new Proxy({}, { get() { throw new Error("unexpected database access"); } });
  const member = { userId: "member-A", roles: ["member-submitter"] as const, memberStateId: "A" };
  for (const payload of [text(), text("NNP", { entries: [{ country_or_area: { en: "Aland" } }] })]) {
    await assert.rejects(createSubmission(noDatabaseAccess as never, { ...member, roles: [...member.roles] }, {
      register_id: "NNP", slug: "nnp", action_type: "ADD", payload,
    }), (error: unknown) => error instanceof ValidationFailed && error.errors.some((e) => e.message.includes("country scope cannot be verified")));
  }
  await assert.rejects(createSubmission(noDatabaseAccess as never, { userId: "itu", roles: ["itu-editor"], memberStateId: null }, {
    register_id: "NNP", slug: "other", action_type: "ADD", payload: text(),
  }), (error: unknown) => error instanceof ValidationFailed && error.errors[0]?.path === "slug");
});
