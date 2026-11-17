import { COUNTRY_MEMBERS } from "./country-members.generated.ts";

/** Only committed, unambiguous data-derived aliases confer country authority. */
export function countryMemberId(label: string): string | null {
  const key = label.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
  return Object.hasOwn(COUNTRY_MEMBERS, key) ? COUNTRY_MEMBERS[key] : null;
}
