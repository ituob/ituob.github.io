import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { COUNTRY_MEMBERS } from "../worker/lib/country-members.generated.ts";
import { countryMemberId } from "../worker/lib/country-member.ts";
import { authorizeEntries } from "../worker/lib/authz.ts";
import { registerKeysOf } from "../worker/lib/validation.ts";
import { REGISTER_IDENTITIES } from "../src/lib/register-rules.generated.ts";
import exceptions from "./fixtures/country-coverage-exceptions.json";
import { db } from "./helpers.ts";

const coverage = (env as any).TEST_COUNTRY_COVERAGE as {
  generated: string; committed: string; datasets: { register: string; labels: string[] }[];
};
const members = (env as any).TEST_ROSTER_SEED.records as { id: string }[];
const ids = new Set(members.map(m => m.id));

it("commits exactly the deterministic country mapping from the pinned structured data", () => {
  expect(coverage.generated).toBe(coverage.committed);
  for (const id of Object.values(COUNTRY_MEMBERS)) expect(ids.has(id), id).toBe(true);
  expect(countryMemberId("__proto__")).toBeNull();
  expect(countryMemberId("constructor")).toBeNull();
});

for (const dataset of coverage.datasets) it(`${dataset.register}: every country label has one member or an explicit known exception`, () => {
  const unresolved = dataset.labels.filter(label => countryMemberId(label) === null);
  const expected = (exceptions as Record<string, Record<string, string>>)[dataset.register];
  expect(expected, `Missing inventory for ${dataset.register}`).toBeDefined();
  expect(unresolved).toEqual(Object.keys(expected).sort());
  for (const label of unresolved) expect(expected[label].length).toBeGreaterThan(10);
  for (const label of dataset.labels.filter(label => !unresolved.includes(label))) {
    // Generated object keys are unique; every value names exactly one seeded member.
    expect(members.filter(member => member.id === countryMemberId(label)), label).toHaveLength(1);
  }
});

it("has no stale register exception inventories", () => {
  expect(Object.keys(exceptions).sort()).toEqual(coverage.datasets.map(d => d.register).sort());
});

for (const [register, rule] of Object.entries(REGISTER_IDENTITIES)) {
  const field = rule.amendmentClass ? rule.countryField : null;
  if (!field) continue;
  it(`${register}: country extraction uses shared member authorization`, async () => {
    await db().prepare("INSERT INTO members (id,name,register_key,status,created_at,updated_at) VALUES ('algeria','Algeria','Canonical Algeria','active','t','t')").run();
    const keys = registerKeysOf(register, { data: { _class: rule.amendmentClass, entries: [{ [field]: { fr: "Algérie" } }] } });
    expect(keys).toEqual(["Algérie"]);
    const snap = await authorizeEntries(db(), { userId: "verified", roles: ["member-submitter"], memberStateId: "algeria" }, keys);
    expect(snap.affiliation_member_id).toBe("algeria");
    await expect(authorizeEntries(db(), { userId: "other", roles: ["member-submitter"], memberStateId: "australia" }, keys)).rejects.toThrow();
  });
}
