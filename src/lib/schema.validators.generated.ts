// GENERATED from ituob/lib/ituob/ontology/messages.lml — do not edit.
// Regenerate: bundle exec ruby scripts/generate_ts_types.rb
// Runtime validators for the Worker; CI regenerates and diff-checks this file.
// Erasable TypeScript only (runs under node --experimental-strip-types).

export type FieldKind =
  | "string" | "integer" | "float" | "boolean" | "date" | "time"
  | "hash" | "hashOrText" | "dateOrText" | "enum" | "class";

export interface FieldSpec {
  kind: FieldKind;
  /** Enum or class name when kind is "enum" or "class". */
  ref?: string;
  many?: true;
  required?: true;
}

export interface SchemaIssue {
  path: string;
  code: "required" | "type" | "enum" | "unknown";
  message: string;
}


export const ENUMS: Readonly<Record<string, readonly string[]>> = {
  "ActionType": ["ADD", "SUP", "REP", "LIR", "MOD", "DEL", "SEED"],
};

export const CLASSES: Readonly<Record<string, Readonly<Record<string, FieldSpec>>>> = {
  "Amendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
  },
  "Change": {
    "type": { kind: "string" },
    "identifier": { kind: "string" },
    "data": { kind: "class", ref: "Entry" },
  },
  "ChangeSet": {
    "date_requested": { kind: "string" },
    "date_active": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "reference": { kind: "string" },
    "changes": { kind: "class", ref: "Change", many: true },
  },
  "DPAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "country": { kind: "string" },
    "description": { kind: "string" },
    "entries": { kind: "class", ref: "DPEntry", many: true },
    "notes": { kind: "string" },
  },
  "DPAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "DPAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "DPEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "DPEntry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_code": { kind: "string" },
    "international_prefix": { kind: "string" },
    "national_prefix": { kind: "string" },
    "national_sig_number": { kind: "string" },
    "utc_dst": { kind: "string" },
    "note": { kind: "class", ref: "MultilingualString" },
  },
  "E118Action": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E118Entry", many: true },
  },
  "E118Amendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "E118Action", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E118Entry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "E118Entry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "company_name": { kind: "string" },
    "company_address_1": { kind: "string" },
    "company_address_2": { kind: "string" },
    "company_address_3": { kind: "string" },
    "contact": { kind: "string" },
    "contact_address_1": { kind: "string" },
    "contact_address_2": { kind: "string" },
    "contact_address_3": { kind: "string" },
    "contact_address_4": { kind: "string" },
    "contact_address_5": { kind: "string" },
    "contact_address_6": { kind: "string" },
    "tel": { kind: "string", many: true },
    "fax": { kind: "string", many: true },
    "email": { kind: "string", many: true },
    "issue_id_number": { kind: "string" },
    "effective_date": { kind: "string" },
  },
  "E164ACNAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E164ACNEntry", many: true },
    "notes": { kind: "string" },
  },
  "E164ACNAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "E164ACNAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E164ACNEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "E164ACNEntry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_code": { kind: "string" },
    "mobile_telephone_numbers": { kind: "class", ref: "MultilingualString" },
  },
  "E164BEntry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_code": { kind: "string" },
    "mobile_telephone_numbers": { kind: "class", ref: "MultilingualString" },
    "remarks": { kind: "string" },
  },
  "E164CCAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E164CCEntry", many: true },
    "notes": { kind: "string" },
    "note": { kind: "string" },
  },
  "E164CCAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "E164CCAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E164CCEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "E164CCEntry": {
    "_class": { kind: "string" },
    "applicant": { kind: "string" },
    "network": { kind: "string" },
    "cc_ic": { kind: "string" },
    "status": { kind: "string" },
    "formerly": { kind: "string" },
    "action_date": { kind: "string" },
    "reclamation_date": { kind: "string" },
  },
  "E164DEntry": {
    "_class": { kind: "string" },
    "country_code": { kind: "string" },
    "country_area_or_service": { kind: "class", ref: "MultilingualString" },
    "note": { kind: "class", ref: "MultilingualString" },
  },
  "E164DNoteNEntry": {
    "_class": { kind: "string" },
    "network": { kind: "string" },
    "cc_ic": { kind: "string" },
    "status": { kind: "string" },
  },
  "E164DNoteOEntry": {
    "_class": { kind: "string" },
    "applicant": { kind: "string" },
    "network": { kind: "string" },
    "cc_ic": { kind: "string" },
    "status": { kind: "string" },
    "formerly": { kind: "string" },
  },
  "E164DNotePQEntry": {
    "_class": { kind: "string" },
    "applicant": { kind: "string" },
    "network": { kind: "string" },
    "cc_ic": { kind: "string" },
    "status": { kind: "string" },
    "formerly": { kind: "string" },
  },
  "E212MNCAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E212MNCEntry", many: true },
    "notes": { kind: "string" },
    "note": { kind: "string" },
  },
  "E212MNCAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "E212MNCAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E212MNCEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "E212MNCEntry": {
    "_class": { kind: "string" },
    "mcc_mnc_codes": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "networks": { kind: "string" },
    "note": { kind: "class", ref: "MultilingualString" },
    "former_name": { kind: "string" },
    "range": { kind: "string" },
  },
  "E218TRCCAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E218TRCCEntry", many: true },
    "notes": { kind: "string" },
  },
  "E218TRCCAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "E218TRCCAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "E218TRCCEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "E218TRCCEntry": {
    "_class": { kind: "string" },
    "tmcc_code": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "reserved": { kind: "boolean" },
    "note": { kind: "class", ref: "MultilingualString" },
  },
  "Entry": {
    "_class": { kind: "string" },
  },
  "F32TDIAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "description": { kind: "string" },
    "entries": { kind: "class", ref: "F32TDIEntry", many: true },
  },
  "F32TDIAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "F32TDIAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "F32TDIEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "F32TDIEntry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_or_area_note": { kind: "class", ref: "MultilingualString" },
    "notes": { kind: "class", ref: "MultilingualString" },
    "network_roa": { kind: "string" },
    "network_roa_note": { kind: "string" },
    "network_code": { kind: "string" },
    "network_code_note": { kind: "class", ref: "MultilingualString" },
    "telegraph_office_name": { kind: "class", ref: "MultilingualString" },
    "office_code": { kind: "string" },
    "office_code_note": { kind: "class", ref: "MultilingualString" },
    "subarea": { kind: "class", ref: "MultilingualString" },
  },
  "F400Action": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "F400Entry", many: true },
    "notes": { kind: "string" },
  },
  "F400Amendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "F400Action", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "F400Entry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "F400Entry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "admd_name": { kind: "string" },
    "not_operational_yet": { kind: "boolean" },
    "country_code": { kind: "string" },
    "for_test_purposes": { kind: "boolean" },
    "mt": { kind: "string" },
    "ipm": { kind: "string" },
    "other": { kind: "string" },
    "helpdesk": { kind: "hash" },
    "autoanswer": { kind: "hash" },
    "contact_address": { kind: "hash" },
    "note": { kind: "string" },
  },
  "GeneralApprovedRecommendation": {
    "recommendation": { kind: "string" },
    "approved_date": { kind: "dateOrText" },
  },
  "GeneralApprovedRecommendations": {
    "type": { kind: "string" },
    "items": { kind: "class", ref: "GeneralApprovedRecommendation", many: true },
    "by": { kind: "string" },
    "procedures": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "payload": { kind: "hash" },
    "contents": { kind: "hash" },
  },
  "GeneralCallbackProcedures": {
    "type": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralCustom": {
    "type": { kind: "string" },
    "title": { kind: "hash" },
    "recommendation": { kind: "string" },
    "text": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralIpns": {
    "type": { kind: "string" },
    "network": { kind: "string" },
    "mcc_mnc": { kind: "string" },
    "date_of_assignment": { kind: "string" },
    "notes": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralIptn": {
    "type": { kind: "string" },
    "entries": { kind: "class", ref: "IptnEntry", many: true },
    "notes": { kind: "string" },
    "manual": { kind: "boolean" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralMessage": {
    "type": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralMid": {
    "type": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralMiscCommunications": {
    "type": { kind: "string" },
    "text": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hashOrText" },
  },
  "GeneralOrgChanges": {
    "type": { kind: "string" },
    "text": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralRunningAnnexes": {
    "type": { kind: "string" },
    "extra_links": { kind: "string", many: true },
    "ob_issue_no": { kind: "string" },
    "payload": { kind: "hash" },
    "contents": { kind: "hash" },
  },
  "GeneralSanc": {
    "country": { kind: "string" },
    "sanc": { kind: "string" },
  },
  "GeneralSancs": {
    "type": { kind: "string" },
    "items": { kind: "class", ref: "GeneralSanc", many: true },
    "notes": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "GeneralServiceRestriction": {
    "country": { kind: "class", ref: "MultilingualString" },
    "ob": { kind: "integer" },
    "page": { kind: "integer" },
  },
  "GeneralServiceRestrictions": {
    "type": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "items": { kind: "class", ref: "GeneralServiceRestriction", many: true },
    "contents": { kind: "hash" },
  },
  "GeneralTelephoneCommunication": {
    "date": { kind: "dateOrText" },
    "contents": { kind: "hash" },
  },
  "GeneralTelephoneSection": {
    "type": { kind: "string" },
    "country_name": { kind: "class", ref: "MultilingualString" },
    "phone_code": { kind: "string" },
    "contact": { kind: "class", ref: "MultilingualString" },
    "communications": { kind: "class", ref: "GeneralTelephoneCommunication", many: true },
  },
  "GeneralTelephoneService": {
    "type": { kind: "string" },
    "text": { kind: "string" },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "class", ref: "GeneralTelephoneSection", many: true },
  },
  "GeneralTelephoneServices": {
    "type": { kind: "string" },
    "items": { kind: "class", ref: "GeneralTelephoneService", many: true },
    "ob_issue_no": { kind: "string" },
    "contents": { kind: "hash" },
  },
  "Identifier": {
    "code": { kind: "string" },
    "query": { kind: "hash" },
  },
  "IptnEntry": {
    "applicant": { kind: "string" },
    "network": { kind: "string" },
    "cc_ic": { kind: "string" },
    "action": { kind: "string" },
    "action_date": { kind: "string" },
    "formerly": { kind: "string" },
    "notes": { kind: "string" },
    "reclamation_date": { kind: "string" },
    "trial": { kind: "boolean" },
  },
  "IssueAuthor": {
    "name": { kind: "string" },
    "address": { kind: "string" },
    "contacts": { kind: "class", ref: "IssueContact", many: true },
    "recommended": { kind: "boolean" },
  },
  "IssueContact": {
    "type": { kind: "string" },
    "data": { kind: "string" },
    "recommended": { kind: "boolean" },
  },
  "IssueGeneral": {
    "messages": { kind: "class", ref: "GeneralMessage", many: true },
  },
  "IssueMetadata": {
    "id": { kind: "integer" },
    "incomplete": { kind: "boolean" },
    "publication_date": { kind: "dateOrText" },
    "cutoff_date": { kind: "dateOrText" },
    "issn": { kind: "string" },
    "languages": { kind: "hash" },
    "authors": { kind: "class", ref: "IssueAuthor", many: true },
  },
  "ListVIIIAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "country": { kind: "string" },
    "description": { kind: "string" },
    "entries": { kind: "class", ref: "ListVIIIStation", many: true },
  },
  "ListVIIIAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "ListVIIIAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "ListVIIIStation", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "ListVIIICentralizingOffice": {
    "name": { kind: "string" },
    "postal_address": { kind: "string" },
    "contact": { kind: "string" },
    "remarks": { kind: "string" },
  },
  "ListVIIIMeasurement": {
    "section": { kind: "string" },
    "measurement_type": { kind: "string" },
    "coordinates": { kind: "string" },
    "hours_of_service": { kind: "string" },
    "frequency_ranges": { kind: "string" },
    "details": { kind: "string" },
    "remarks": { kind: "string" },
  },
  "ListVIIIStation": {
    "_class": { kind: "string" },
    "country": { kind: "string" },
    "name": { kind: "string" },
    "postal_address": { kind: "string" },
    "contact": { kind: "string" },
    "part_ii_reference": { kind: "string" },
    "part_iii_reference": { kind: "string" },
    "centralizing_office": { kind: "class", ref: "ListVIIICentralizingOffice" },
    "measurements": { kind: "class", ref: "ListVIIIMeasurement", many: true },
  },
  "M1400Action": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "M1400Entry", many: true },
    "notes": { kind: "string" },
    "note": { kind: "string" },
  },
  "M1400Amendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "M1400Action", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "M1400Entry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "M1400Entry": {
    "_class": { kind: "string" },
    "iso_code": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "company_name": { kind: "string" },
    "address_line_1": { kind: "string" },
    "address_line_2": { kind: "string" },
    "address_line_3": { kind: "string" },
    "carrier_code": { kind: "string" },
    "contact": { kind: "string" },
    "tel": { kind: "string" },
    "fax": { kind: "string" },
    "email": { kind: "string", many: true },
  },
  "MultilingualString": {
    "en": { kind: "string" },
    "fr": { kind: "string" },
    "es": { kind: "string" },
    "zh": { kind: "string" },
    "ru": { kind: "string" },
    "ar": { kind: "string" },
  },
  "NNPAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "description": { kind: "string" },
    "entries": { kind: "class", ref: "NumberingPlanEntry", many: true },
  },
  "NNPAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "NNPAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "NumberingPlanEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "NumberingPlanEntry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_code": { kind: "string" },
    "international_prefix": { kind: "string" },
    "national_prefix": { kind: "string" },
    "national_sig_number": { kind: "string" },
    "utc_dst": { kind: "string" },
    "note": { kind: "class", ref: "MultilingualString" },
  },
  "OldIssue": {
    "metadata": { kind: "class", ref: "IssueMetadata" },
    "general": { kind: "class", ref: "IssueGeneral" },
    "amendments": { kind: "class", ref: "Amendment", many: true },
  },
  "Q708ISPCAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "Q708ISPCEntry", many: true },
    "notes": { kind: "string" },
  },
  "Q708ISPCAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "Q708ISPCAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "Q708ISPCEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "Q708ISPCEntry": {
    "_class": { kind: "string" },
    "ipsc": { kind: "string" },
    "country": { kind: "class", ref: "MultilingualString" },
    "dec": { kind: "string" },
    "signal_point_name": { kind: "string" },
    "signal_point_operator": { kind: "string" },
  },
  "Q708SANCAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "Q708SANCEntry", many: true },
    "notes": { kind: "string" },
    "order": { kind: "string" },
  },
  "Q708SANCAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "Q708SANCAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "Q708SANCEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "Q708SANCEntry": {
    "_class": { kind: "string" },
    "code": { kind: "string" },
    "area_or_network": { kind: "class", ref: "MultilingualString" },
    "note": { kind: "class", ref: "MultilingualString" },
  },
  "RR251Action": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "RR251Entry", many: true },
    "notes": { kind: "string" },
  },
  "RR251Amendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "RR251Action", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "RR251Entry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "RR251Entry": {
    "_class": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "country_or_area_note": { kind: "class", ref: "MultilingualString" },
    "notes": { kind: "class", ref: "MultilingualString" },
    "network_roa": { kind: "string" },
    "network_roa_note": { kind: "string" },
    "network_code": { kind: "string" },
    "network_code_note": { kind: "class", ref: "MultilingualString" },
    "telegraph_office_name": { kind: "class", ref: "MultilingualString" },
    "office_code": { kind: "string" },
    "office_code_note": { kind: "class", ref: "MultilingualString" },
    "subarea": { kind: "class", ref: "MultilingualString" },
  },
  "RegisterChange": {
    "type": { kind: "enum", ref: "ActionType" },
    "register": { kind: "string" },
    "identifier": { kind: "class", ref: "Identifier", required: true },
    "recommendation": { kind: "string" },
    "data": { kind: "hash" },
    "ob_issue_no": { kind: "integer" },
    "date_active": { kind: "string" },
    "date_requested": { kind: "string" },
    "reference": { kind: "string" },
    "description": { kind: "hash" },
    "superseded_by": { kind: "hash" },
    "reason": { kind: "hash" },
    "merge_strategy": { kind: "string" },
  },
  "T35AssignmentAuthority": {
    "terminal_type": { kind: "string" },
    "contact_name": { kind: "string" },
    "organization": { kind: "string" },
    "department": { kind: "string" },
    "address": { kind: "string" },
    "telephone": { kind: "string" },
    "fax": { kind: "string" },
    "email": { kind: "string" },
    "related_links": { kind: "string", many: true },
  },
  "T35NAAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "T35NAEntry", many: true },
    "notes": { kind: "string" },
  },
  "T35NAAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "T35NAAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "T35NAEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "T35NAEntry": {
    "_class": { kind: "string" },
    "country": { kind: "string" },
    "administration_name": { kind: "string" },
    "manufactures_htv": { kind: "string" },
    "last_updated": { kind: "string" },
    "assignment_authority": { kind: "class", ref: "T35AssignmentAuthority", many: true },
    "note": { kind: "string" },
  },
  "TextAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
  },
  "TextAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "TextAction", many: true },
    "dataset_code": { kind: "string" },
    "text": { kind: "string" },
  },
  "X121DNICAction": {
    "action_type": { kind: "string" },
    "position": { kind: "string" },
    "country": { kind: "string" },
    "caption": { kind: "string" },
    "description": { kind: "string" },
    "entries": { kind: "class", ref: "X121DNICEntry", many: true },
  },
  "X121DNICAmendment": {
    "_class": { kind: "string" },
    "position_on": { kind: "date" },
    "notes": { kind: "string", many: true },
    "actions": { kind: "class", ref: "X121DNICAction", many: true },
    "position": { kind: "string" },
    "entries": { kind: "class", ref: "X121DNICEntry", many: true },
    "description": { kind: "string" },
    "caption": { kind: "string" },
    "country": { kind: "string" },
  },
  "X121DNICEntry": {
    "_class": { kind: "string" },
    "dnic_number": { kind: "string" },
    "country_or_area": { kind: "class", ref: "MultilingualString" },
    "network_name": { kind: "string" },
    "note": { kind: "string" },
  },
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const KIND_LABEL: Record<string, string> = {
  string: "a string", integer: "an integer", float: "a number", boolean: "a boolean",
  date: "an ISO date string (YYYY-MM-DD)", time: "a timestamp string", hash: "an object",
  hashOrText: "an object or a string", dateOrText: "a string", enum: "an enum member", class: "an object",
};

function scalarOk(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case "string": return typeof v === "string";
    case "integer": return (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v));
    case "float": return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)));
    case "boolean": return typeof v === "boolean";
    case "date": return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v);
    case "time": return typeof v === "string";
    case "hash": return isObj(v);
    case "hashOrText": return isObj(v) || typeof v === "string";
    case "dateOrText": return typeof v === "string";
    default: return false;
  }
}

function checkValue(spec: FieldSpec, v: unknown, path: string, out: SchemaIssue[]): void {
  if (spec.kind === "enum") {
    const members = ENUMS[spec.ref as string] ?? [];
    if (typeof v !== "string" || !members.includes(v))
      out.push({ path, code: "enum", message: `${path} must be one of ${members.join(", ")}` });
  } else if (spec.kind === "class") {
    out.push(...validateClass(spec.ref as string, v, path));
  } else if (!scalarOk(spec.kind, v)) {
    out.push({ path, code: "type", message: `${path} must be ${KIND_LABEL[spec.kind]}` });
  }
}

/**
 * Validate `value` against the ontology class `name`. Unknown keys are
 * rejected (the Ruby gate rejects them too); null/absent optional keys pass.
 */
export function validateClass(name: string, value: unknown, path = ""): SchemaIssue[] {
  const fields = CLASSES[name];
  const at = path === "" ? "(root)" : path;
  if (!fields) return [{ path, code: "unknown", message: `unknown class ${name}` }];
  if (!isObj(value)) return [{ path, code: "type", message: `${at} must be an object (${name})` }];
  const out: SchemaIssue[] = [];
  const sub = (k: string) => (path === "" ? k : `${path}.${k}`);
  for (const k of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(fields, k))
      out.push({ path: sub(k), code: "unknown", message: `${sub(k)} is not an attribute of ${name}` });
  }
  for (const [k, spec] of Object.entries(fields)) {
    const v = value[k];
    if (v === undefined || v === null) {
      if (spec.required) out.push({ path: sub(k), code: "required", message: `${sub(k)} is required` });
      continue;
    }
    if (spec.many) {
      if (!Array.isArray(v)) {
        out.push({ path: sub(k), code: "type", message: `${sub(k)} must be a list` });
        continue;
      }
      v.forEach((item, i) => checkValue(spec, item, `${sub(k)}[${i}]`, out));
    } else {
      checkValue(spec, v, sub(k), out);
    }
  }
  return out;
}

/** Class names usable as a register amendment payload (`data._class`). */
export const AMENDMENT_CLASSES: readonly string[] = Object.keys(CLASSES).filter(
  (n) => n.endsWith("Amendment") && n !== "Amendment",
);
