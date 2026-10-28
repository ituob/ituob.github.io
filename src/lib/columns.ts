/**
 * Display order and labels for register columns. The printed bulletins
 * lead with the country or area; the flattened data does not, so the
 * order has to be restored here.
 */

const COUNTRY_FIELDS = [
  "country_or_area",
  "country_code",
  "country_area_or_service",
  "country_or_geographical_area",
  "country",
  "geographical_area",
];

const NAME_FIELDS = [
  "company_name",
  "applicant",
  "network",
  "network_name",
  "operator",
  "signal_point_name",
  "signal_point_operator",
  "station",
  "description",
  "telegraph_office_name",
  "administration_name",
  "admd_name",
];

const ADDRESS_FIELDS = [
  "company_address_1",
  "company_address_2",
  "company_address_3",
  "company_address_4",
  "address_line_1",
  "address_line_2",
  "address_line_3",
];

const CONTACT_FIELDS = [
  "contact",
  "contact_address",
  "contact_address_1",
  "contact_address_2",
  "contact_address_3",
  "contact_address_4",
  "contact_address_5",
];

const CONTACT_MEDIA = ["tel", "fax", "email"];

const MEDIA_RANK = new Map(CONTACT_MEDIA.map((field, i) => [field, i]));

const TRAILING_FIELDS = ["status", "effective_date", "note", "notes"];

const LABELS: Record<string, string> = {
  country_or_area: "Country or area",
  country_code: "Country code",
  country_area_or_service: "Country, area or service",
  country_or_geographical_area: "Country or area",
  country: "Country",
  geographical_area: "Country or area",
  issue_id_number: "Issuer identifier number",
  mcc_mnc_codes: "MCC/MNC",
  cc_ic: "CC/IC",
  tmcc_code: "TMCC",
  utc_dst: "UTC/DST",
  admd_name: "ADMD name",
  ipm: "IPM",
  company_name: "Company",
  bureaufax_number: "Bureaufax number",
  mobile_telephone_numbers: "Mobile telephone numbers",
  company_address_1: "Address",
  company_address_2: "Address line 2",
  company_address_3: "Address line 3",
  company_address_4: "Address line 4",
  contact_address_1: "Contact address",
  contact_address_2: "Contact address 2",
  contact_address_3: "Contact address 3",
  contact_address_4: "Contact address 4",
  network_code: "Network code",
  network_code_note: "Network code note",
  office_code: "Office code",
  office_code_note: "Office code note",
  country_or_area_note: "Country or area note",
  network_roa: "Network ROA",
  network_roa_note: "Network ROA note",
  iso_code: "ISO code",
  ipsc: "ISPC",
  dnic_number: "DNIC",
  signal_point_name: "Signal point",
  applicant: "Applicant",
  network: "Network",
  operator: "Operator",
  description: "Description",
  status: "Status",
  effective_date: "Effective date",
  tel: "Telephone",
  fax: "Fax",
  email: "Email",
};

export function fieldLabel(field: string): string {
  const known = LABELS[field];
  if (known) return known;
  const words = field.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function orderFields(fields: string[], keyFields: string[]): string[] {
  const isKey = new Set(keyFields);
  const group = (field: string): number => {
    if (COUNTRY_FIELDS.includes(field)) return 0;
    if (isKey.has(field)) return 1;
    if (NAME_FIELDS.includes(field)) return 2;
    if (ADDRESS_FIELDS.includes(field)) return 3;
    if (CONTACT_FIELDS.includes(field)) return 4;
    if (CONTACT_MEDIA.includes(field)) return 5;
    if (TRAILING_FIELDS.includes(field)) return 6;
    return 7;
  };
  return fields.slice().sort((a, b) => {
    const g = group(a) - group(b);
    if (g !== 0) return g;
    if (CONTACT_MEDIA.includes(a) && CONTACT_MEDIA.includes(b)) {
      return MEDIA_RANK.get(a)! - MEDIA_RANK.get(b)!;
    }
    return fieldLabel(a).localeCompare(fieldLabel(b));
  });
}

export function hasValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).some(hasValue);
  return true;
}
