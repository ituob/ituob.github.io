// A small catalog in the shapes catalogs/registers.yaml really uses: flow and
// block titles, comments, a legacy id, and an entry with a url already set.
export const REGISTERS_YAML = `# Canonical catalog of OB Registers.

registers:
  # === E.118 ===
  - register_id: E118_IIN
    slug: e118-iin
    recommendation: E.118
    title: { en: List of Issuer Identifier Numbers }
    key_field: issue_id_number
    classification: structured
    parser_class: Ituob::Models::E118Amendment
    renderer: iin-table
    seed_issue: 1161

  # === E.164 ===
  - register_id: DP
    slug: dp
    recommendation: E.164
    title:
      en: Dialling Procedures (International prefix)
      fr: Procedures de numerotation
    key_field: country_code
    classification: structured
    renderer: dp-table

  # === External (not annexed) ===
  - register_id: List of Coast Stations
    slug: coast-stations
    recommendation: RR.25.1
    title: { en: List of Coast Stations }
    url: https://www.itu.int/old
    key_field: callsign
    classification: textual
    renderer: text-amendment
    external: true
`;
export const RECOMMENDATIONS_YAML = `recommendations:
  - code: E.118
    title:
      en: Charge card
  - code: E.164
    title:
      en: Numbering plan
  - code: RR.25.1
    title:
      en: Radio Regulations
`;
