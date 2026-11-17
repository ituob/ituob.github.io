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
      { country_or_area: { en: "Aland" }, company_name: "Acme Telecom", issue_id_number: "89 358 01" },
    ] } };
    assert.deepEqual(validate({ register_id: "E118_IIN", action_type, payload }), []);
    assert.deepEqual(registerKeysOf("E118_IIN", payload), ["Aland"]);
    assert.ok(validate({ register_id: "E118_IIN", action_type, payload: { type: action_type, data: { _class: "E118Amendment" } } }).some((e) => e.path === "data.entries"));
  }
  assert.ok(errors({ type: "ADD", data: { _class: "E118Amendment", entries: [{ company_name: "Acme" }] } }, "E118_IIN").some((e) => e.path === "data.entries[0].country_or_area"));
});

test("specialized NNP/RR251 entry schemas and country binding remain usable", () => {
  for (const [id, cls, entry] of [
    ["NNP", "NNPAmendment", { country_or_area: { en: "Aland" } }],
    ["RR.25.1", "RR251Amendment", { country_or_area: { en: "Aland" } }],
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


test("E164_CC accepts primary and fallback identities without inventing a country authority attribute", () => {
  for (const action_type of ACTION_TYPES) {
    const payload = { type: action_type, data: { _class: "E164CCAmendment", entries: [{ cc_ic: "+883 5100", applicant: "Example network" }] } };
    assert.deepEqual(validate({ register_id: "E164_CC", slug: "e164-cc", action_type, payload }), []);
    assert.deepEqual(registerKeysOf("E164_CC", payload), []);
    const primary = { ...payload, data: { ...payload.data, entries: [{ country_code: "+883", applicant: "Example network" }] } };
    assert.deepEqual(validate({ register_id: "E164_CC", action_type, payload: primary }), []);
    assert.deepEqual(registerKeysOf("E164_CC", primary), []);
    for (const entry of [{ applicant: "Example network" }, { country_code: " ", cc_ic: " " }]) {
      const unkeyed = { ...payload, data: { ...payload.data, entries: [entry] } };
      assert.ok(validate({ register_id: "E164_CC", action_type, payload: unkeyed }).some(e =>
        e.code === "required" && e.path === "data.entries[0].country_code" && e.message.includes("country_code or cc_ic")), action_type);
    }
  }
});

test("country authority cannot substitute for a missing register identity", () => {
  for (const [id, cls, key] of [
    ["E118_IIN", "E118Amendment", "issue_id_number"],
    ["DP", "DPAmendment", "country_code"],
    ["E212_MNC", "E212MNCAmendment", "mcc_mnc_codes"],
    ["E218_TRCC", "E218TRCCAmendment", "tmcc_code"],
    ["M1400_ICC", "M1400Amendment", "carrier_code"],
  ] as const) {
    for (const action_type of ACTION_TYPES) {
      const entry = { country_or_area: { en: "Aland" }, ...(id === "E118_IIN" ? { company_name: "Acme" } : {}) };
      const payload = { type: action_type, data: { _class: cls, entries: [entry] } };
      assert.deepEqual(registerKeysOf(id, payload), ["Aland"]);
      assert.ok(validate({ register_id: id, action_type, payload }).some(e => e.path === `data.entries[0].${key}` && e.code === "required"), `${id}/${action_type}`);
      assert.deepEqual(validate({ register_id: id, action_type, payload: { ...payload, data: { ...payload.data, entries: [{ ...entry, [key]: "123" }] } } }), [], `${id}/${action_type}`);
    }
  }
});

test("multilingual catalog identities require a nonblank canonical language", () => {
  const payload = (country_or_area: unknown) => ({ type: "ADD", data: { _class: "NNPAmendment", entries: [{ country_or_area }] } });
  assert.deepEqual(errors(payload({ fr: "Aland" })), []);
  for (const country of [{ en: " " }, { xx: "Aland" }]) {
    assert.ok(errors(payload(country)).some(e => e.code === "required" && e.path === "data.entries[0].country_or_area"));
  }
});

test("F32 requires the catalog office identity independently of multilingual country authority", () => {
  for (const action_type of ACTION_TYPES) {
    const context = { register_id: "F32_TDI", action_type };
    const payload = (entry: unknown) => ({ type: action_type, data: { _class: "F32TDIAmendment", entries: [entry] } });
    assert.deepEqual(validate({ ...context, payload: payload({ country_or_area: { fr: "Aland" }, office_code: "AABB" }) }), []);
    for (const entry of [
      { country_or_area: { fr: "Aland" } },
      { country_or_area: { en: "Aland" }, network_code: "AA" },
      { country_or_area: { en: "Aland" }, office_code: " " },
    ]) {
      assert.ok(validate({ ...context, payload: payload(entry) }).some(e => e.path === "data.entries[0].office_code" && e.code === "required"), action_type);
    }
    assert.ok(validate({ ...context, payload: payload({ office_code: "AABB" }) }).some(e => e.path === "data.entries[0].country_or_area" && e.code === "required"), action_type);
    assert.ok(validate({ ...context, payload: payload({ country_or_area: { en: " " }, office_code: "AABB" }) }).some(e => e.path === "data.entries[0].country_or_area" && e.code === "required"), action_type);
  }
});

test("ListVIII reports its unrepresentable canonical identity while authorized text remains valid", () => {
  const payload = { type: "ADD", data: { _class: "ListVIIIAmendment", entries: [{ country: "Aland", name: "Station" }] } };
  assert.deepEqual(validateClass("ListVIIIAmendment", payload.data), []);
  assert.deepEqual(registerKeysOf("R_SP_LN.VIII", payload), ["Aland"]);
  assert.deepEqual(errors(payload, "R_SP_LN.VIII"), [{ path: "data._class", code: "mismatch", message: "Catalog identity (callsign) is not represented by ListVIIIAmendment; the catalog and model must be aligned before typed entries can be saved" }]);
  assert.deepEqual(errors(text("R_SP_LN.VIII"), "R_SP_LN.VIII"), []);
});

test("structured registers cannot borrow another amendment's country or identity model", () => {
  const payload = { type: "ADD", data: { _class: "NNPAmendment", entries: [{ country_or_area: { en: "Aland" } }] } };
  assert.ok(errors(payload, "E118_IIN").some(e => e.code === "mismatch" && e.path === "data._class"));
});

test("country-less E164 member input fails closed before any database access", async () => {
  const { createSubmission } = await import("../worker/lib/submissions.ts");
  const { InvalidError } = await import("../worker/lib/membership.ts");
  const db = new Proxy({}, { get() { throw new Error("unexpected database access"); } });
  await assert.rejects(createSubmission(db as never, { userId: "member-A", roles: ["member-submitter"], memberStateId: "A" }, {
    register_id: "E164_CC", slug: "e164-cc", action_type: "ADD", payload: { type: "ADD", data: { _class: "E164CCAmendment", entries: [{ cc_ic: "+883 5100", applicant: "Example" }] } },
  }), error => error instanceof InvalidError && error.message.includes("no country/area key"));
});


test("unknown register identities fail closed, including object property names", () => {
  const payload = { type: "ADD", data: { _class: "NNPAmendment", entries: [{ country_or_area: { en: "Aland" } }] } };
  for (const cls of ["__proto__", "constructor", "UnknownAmendment"]) {
    assert.ok(errors({ ...payload, data: { _class: cls, entries: [{}] } }, "E118_IIN").some(e => e.path === "data._class" && e.code === "enum"));
  }
  for (const id of ["UNKNOWN", "__proto__", "constructor", "toString"]) {
    assert.ok(errors(payload, id).some(e => e.path === "register_id" && e.code === "unknown"));
    assert.deepEqual(registerKeysOf(id, payload), []);
  }
});

test("unknown amendment classes require country scope before member validation; staff still receive schema errors without writes", async () => {
  const { createSubmission, ValidationFailed } = await import("../worker/lib/submissions.ts");
  const { InvalidError } = await import("../worker/lib/membership.ts");
  const noDatabaseAccess = new Proxy({}, { get() { throw new Error("unexpected database access"); } });
  const member = { userId: "member-A", roles: ["member-submitter"] as ["member-submitter"], memberStateId: "A" };
  const input = {
    register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD",
    payload: { type: "DEL", data: { _class: "nope", entries: [{ country_or_area: { en: "Aland" }, issue_id_number: "89 358 01", company_name: "Acme" }] } },
  };
  await assert.rejects(createSubmission(noDatabaseAccess as never, member, input),
    (error: unknown) => error instanceof InvalidError && error.message.includes("no country/area key"));
  await assert.rejects(createSubmission(noDatabaseAccess as never, { userId: "itu", roles: ["itu-editor"], memberStateId: null }, input),
    (error: unknown) => error instanceof ValidationFailed && JSON.stringify(error.errors.map(e => e.path).sort()) === JSON.stringify(["data._class", "type"]));
});
