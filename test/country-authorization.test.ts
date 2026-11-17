import { env } from "cloudflare:workers";
import { beforeEach, expect, it } from "vitest";
import { activateMember, addUser, api, db } from "./helpers.ts";

beforeEach(async () => {
  const { committedSql } = (env as any).TEST_ROSTER_SEED;
  for (const line of committedSql.split("\n")) {
    if (line.trim() && !line.startsWith("--")) await db().prepare(line).run();
  }
  await db().prepare("UPDATE members SET status='active' WHERE id='algeria'").run();
  await addUser("algerian");
  await activateMember("algerian", "algeria");
});
const draft = (country: string) => api("POST", "/api/me/submissions", {
  session: "algerian",
  body: { register_id: "E118_IIN", slug: "e118-iin", action_type: "ADD",
    payload: { type: "ADD", data: { _class: "E118Amendment", entries: [{ country_or_area: { en: country }, issue_id_number: "89 213 01", company_name: "Algerian operator" }] } } },
});

it("lets a verified Algerian member submit the actual ROA Algeria label", async () => {
  const result = await draft("Algeria");
  expect(result.status, JSON.stringify(result.json)).toBe(201);
  expect(result.json.submission.affiliation_member_id).toBe("algeria");
});

it("preserves canonical labels and rejects another country or an unknown label", async () => {
  expect((await draft("Algeria (People's Democratic Republic of)")).status).toBe(201);
  expect((await draft("Australia")).status).toBe(403);
  expect((await draft("Unknown country")).status).toBe(403);
});

it("uses the same resolver for multilingual names and codes, and rejects mixed countries", async () => {
  for (const label of ["Algérie", "Argelia", "algeria"]) expect((await draft(label)).status).toBe(201);
  const { authorizeEntries } = await import("../worker/lib/authz.ts");
  const session = { userId: "algerian", roles: ["member-submitter" as const], memberStateId: "algeria" };
  await expect(authorizeEntries(db(), session, ["Algeria", "Australia"])).rejects.toThrow();
  await db().prepare("INSERT INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('conflict','Conflict','Algeria','active','t','t')").run();
  await expect(authorizeEntries(db(), session, ["Algeria"])).rejects.toThrow();
});

it("authorizes country/service and area/network registers, refusing unscoped rows in member batches", async () => {
  for (const [register, slug, cls, field, identity] of [
    ["E164_CC", "e164-cc", "E164CCAmendment", "country_area_or_service", { country_code: "213" }],
    ["Q708_SANC", "q708-sanc", "Q708SANCAmendment", "area_or_network", { code: "2-000" }],
  ] as const) {
    const send = (entries: unknown[]) => api("POST", "/api/me/submissions", { session: "algerian", body: {
      register_id: register, slug, action_type: "ADD", payload: { type: "ADD", data: { _class: cls, entries } },
    } });
    expect((await send([{ ...identity, [field]: { en: "Algeria" } }])).status).toBe(201);
    expect((await send([{ ...identity, [field]: { en: "Algeria" } }, identity])).status).toBe(400);
    expect((await send([{ ...identity, [field]: { en: "Australia" } }])).status).toBe(403);
    // Duplicate identities fail stage 2 only after the whole batch is authorized.
    const before = await db().prepare("SELECT count(*) AS n FROM submission_revisions").first();
    const row = { ...identity, [field]: { en: "Algeria" } };
    expect((await send([row, row])).status).toBe(422);
    expect((await send([row, { ...identity, [field]: { en: "Australia" } }])).status).toBe(403);
    expect(await db().prepare("SELECT count(*) AS n FROM submission_revisions").first()).toEqual(before);
  }
});

it("resolves structured ISO codes but never authorizes known incorrect North Korean translations as South Korea", async () => {
  const { countryMemberId } = await import("../worker/lib/country-member.ts");
  expect(countryMemberId("DZA")).toBe("algeria");
  expect(countryMemberId("iso-3166:ir")).toBe("iran");
  expect(countryMemberId("République populaire démocratique de Corée")).toBeNull();
  expect(countryMemberId("República Popular Democrática de Corea")).toBeNull();
});

it("does not infer country authority for note-only registers that share an amendment class", async () => {
  const { registerKeysOf } = await import("../worker/lib/validation.ts");
  expect(registerKeysOf("E164_NOTE_N", { data: { _class: "E164CCAmendment", entries: [
    { cc_ic: "N", country_area_or_service: { en: "Algeria" } },
  ] } })).toEqual([]);
});
