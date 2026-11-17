/** Printed service-publication headings for normalized register fields. */
export function registerColumnLabel(key: string, entries: Record<string, unknown>[] = []): string {
  const labels: Record<string, string> = {
    networks: "Name of Operator/Network",
    mobile_telephone_numbers: "Mobile telephone numbers, first digits after country code",
    network_roa: "Network (Administration/ROA)",
    network_code: "Destination Indicator (DI) (First 2 letters = Telegram Network Code)",
    telegraph_office_name: "Name of Telegraph Office",
    office_code: "DI Assigned to Telegraph Office (Third and fourth letters = Office Code)",
    manufactures_htv: "National manufacturers of H-, T- or V-Series compliant equipment?",
    administration_name: "Name of Administration:",
    terminal_type: "Assignment authority: Terminal Type:",
    email: "E-mail:",
  };
  if (key === "country_code" && entries.some((entry) => "mobile_telephone_numbers" in entry)) return "E.164 Country Code";
  if (key === "last_updated" && entries.some((entry) => "manufactures_htv" in entry)) return "Information updated:";
  return labels[key] ?? key.replace(/_/g, " ");
}
