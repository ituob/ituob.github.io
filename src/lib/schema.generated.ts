// GENERATED from ituob/lib/ituob/ontology/messages.lml — do not edit.
// Regenerate: bundle exec ruby scripts/generate_ts_types.rb
// CI regenerates this file before every site build.

export interface AmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
}

export interface ChangeWire {
  type?: string;
  identifier?: string;
  data?: EntryWire;
}

export interface ChangeSetWire {
  date_requested?: string;
  date_active?: string;
  ob_issue_no?: string;
  reference?: string;
  changes?: ChangeWire[];
}

export interface DPActionWire {
  action_type?: string;
  position?: string;
  country?: string;
  description?: string;
  entries?: DPEntryWire[];
  notes?: string;
}

export interface DPAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: DPActionWire[];
}

export interface DPEntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_code?: string;
  international_prefix?: string;
  national_prefix?: string;
  national_sig_number?: string;
  utc_dst?: string;
  note?: MultilingualStringWire;
}

export interface E118ActionWire {
  action_type?: string;
  position?: string;
  entries?: E118EntryWire[];
}

export interface E118AmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: E118ActionWire[];
}

export interface E118EntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  company_name?: string;
  company_address_1?: string;
  company_address_2?: string;
  company_address_3?: string;
  contact?: string;
  contact_address_1?: string;
  contact_address_2?: string;
  contact_address_3?: string;
  contact_address_4?: string;
  contact_address_5?: string;
  contact_address_6?: string;
  tel?: string[];
  fax?: string[];
  email?: string[];
  issue_id_number?: string;
  effective_date?: string;
}

export interface E164ACNActionWire {
  action_type?: string;
  position?: string;
  entries?: E164ACNEntryWire[];
  notes?: string;
}

export interface E164ACNAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: E164ACNActionWire[];
}

export interface E164ACNEntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_code?: string;
  mobile_telephone_numbers?: MultilingualStringWire;
}

export interface E164BEntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_code?: string;
  mobile_telephone_numbers?: MultilingualStringWire;
  remarks?: string;
}

export interface E164CCActionWire {
  action_type?: string;
  position?: string;
  entries?: E164CCEntryWire[];
  notes?: string;
  note?: string;
}

export interface E164CCAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: E164CCActionWire[];
}

export interface E164CCEntryWire {
  _class?: string;
  applicant?: string;
  network?: string;
  cc_ic?: string;
  status?: string;
  formerly?: string;
  action_date?: string;
  reclamation_date?: string;
}

export interface E164DEntryWire {
  _class?: string;
  country_code?: string;
  country_area_or_service?: MultilingualStringWire;
  note?: MultilingualStringWire;
}

export interface E164DNoteNEntryWire {
  _class?: string;
  network?: string;
  cc_ic?: string;
  status?: string;
}

export interface E164DNoteOEntryWire {
  _class?: string;
  applicant?: string;
  network?: string;
  cc_ic?: string;
  status?: string;
  formerly?: string;
}

export interface E164DNotePQEntryWire {
  _class?: string;
  applicant?: string;
  network?: string;
  cc_ic?: string;
  status?: string;
  formerly?: string;
}

export interface E212MNCActionWire {
  action_type?: string;
  position?: string;
  entries?: E212MNCEntryWire[];
  notes?: string;
  note?: string;
}

export interface E212MNCAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: E212MNCActionWire[];
}

export interface E212MNCEntryWire {
  _class?: string;
  mcc_mnc_codes?: string;
  country_or_area?: MultilingualStringWire;
  networks?: string;
  note?: MultilingualStringWire;
  former_name?: string;
  range?: string;
}

export interface E218TRCCActionWire {
  action_type?: string;
  position?: string;
  entries?: E218TRCCEntryWire[];
  notes?: string;
}

export interface E218TRCCAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: E218TRCCActionWire[];
}

export interface E218TRCCEntryWire {
  _class?: string;
  tmcc_code?: string;
  country_or_area?: MultilingualStringWire;
  reserved?: boolean;
  note?: MultilingualStringWire;
}

export interface EntryWire {
  _class?: string;
}

export interface F32TDIActionWire {
  action_type?: string;
  position?: string;
  description?: string;
  entries?: F32TDIEntryWire[];
}

export interface F32TDIAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: F32TDIActionWire[];
}

export interface F32TDIEntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_or_area_note?: MultilingualStringWire;
  notes?: MultilingualStringWire;
  network_roa?: string;
  network_roa_note?: string;
  network_code?: string;
  network_code_note?: MultilingualStringWire;
  telegraph_office_name?: MultilingualStringWire;
  office_code?: string;
  office_code_note?: MultilingualStringWire;
  subarea?: MultilingualStringWire;
}

export interface F400ActionWire {
  action_type?: string;
  position?: string;
  entries?: F400EntryWire[];
  notes?: string;
}

export interface F400AmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: F400ActionWire[];
}

export interface F400EntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  admd_name?: string;
  not_operational_yet?: boolean;
  country_code?: string;
  for_test_purposes?: boolean;
  mt?: string;
  ipm?: string;
  other?: string;
  helpdesk?: Record<string, unknown>;
  autoanswer?: Record<string, unknown>;
  contact_address?: Record<string, unknown>;
  note?: string;
}

export interface GeneralApprovedRecommendationWire {
  recommendation?: string;
  approved_date?: string;
}

export interface GeneralApprovedRecommendationsWire {
  type?: string;
  items?: GeneralApprovedRecommendationWire[];
  by?: string;
  procedures?: string;
}

export interface GeneralCallbackProceduresWire {
  type?: string;
}

export interface GeneralCustomWire {
  type?: string;
  text?: string;
}

export interface GeneralIpnsWire {
  type?: string;
  network?: string;
  mcc_mnc?: string;
  date_of_assignment?: string;
  notes?: string;
}

export interface GeneralIptnWire {
  type?: string;
  entries?: IptnEntryWire[];
  notes?: string;
  manual?: boolean;
}

export interface GeneralMessageWire {
  type?: string;
}

export interface GeneralMiscCommunicationsWire {
  type?: string;
  text?: string;
}

export interface GeneralOrgChangesWire {
  type?: string;
  text?: string;
}

export interface GeneralRunningAnnexesWire {
  type?: string;
  extra_links?: string[];
}

export interface GeneralSancWire {
  country?: string;
  sanc?: string;
}

export interface GeneralSancsWire {
  type?: string;
  items?: GeneralSancWire[];
  notes?: string;
}

export interface GeneralServiceRestrictionsWire {
  type?: string;
}

export interface GeneralTelephoneServiceWire {
  type?: string;
  text?: string;
}

export interface GeneralTelephoneServicesWire {
  type?: string;
  items?: GeneralTelephoneServiceWire[];
}

export interface IptnEntryWire {
  applicant?: string;
  network?: string;
  cc_ic?: string;
  action?: string;
  action_date?: string;
  formerly?: string;
  notes?: string;
  reclamation_date?: string;
  trial?: boolean;
}

export interface IssueAuthorWire {
  name?: string;
  address?: string;
  contacts?: IssueContactWire[];
  recommended?: boolean;
}

export interface IssueContactWire {
  type?: string;
  data?: string;
  recommended?: boolean;
}

export interface IssueGeneralWire {
  messages?: GeneralMessageWire[];
}

export interface IssueMetadataWire {
  id?: string;
  publication_date?: string;
  cutoff_date?: string;
  issn?: string;
  languages?: MultilingualStringWire;
  authors?: IssueAuthorWire[];
}

export interface ListVIIIActionWire {
  action_type?: string;
  position?: string;
  country?: string;
  description?: string;
  entries?: ListVIIIStationWire[];
}

export interface ListVIIIAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: ListVIIIActionWire[];
}

export interface ListVIIICentralizingOfficeWire {
  name?: string;
  postal_address?: string;
  contact?: string;
  remarks?: string;
}

export interface ListVIIIMeasurementWire {
  section?: string;
  measurement_type?: string;
  coordinates?: string;
  hours_of_service?: string;
  frequency_ranges?: string;
  details?: string;
  remarks?: string;
}

export interface ListVIIIStationWire {
  _class?: string;
  country?: string;
  name?: string;
  postal_address?: string;
  contact?: string;
  part_ii_reference?: string;
  part_iii_reference?: string;
  centralizing_office?: ListVIIICentralizingOfficeWire;
  measurements?: ListVIIIMeasurementWire[];
}

export interface M1400ActionWire {
  action_type?: string;
  position?: string;
  entries?: M1400EntryWire[];
  notes?: string;
  note?: string;
}

export interface M1400AmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: M1400ActionWire[];
}

export interface M1400EntryWire {
  _class?: string;
  iso_code?: string;
  country_or_area?: MultilingualStringWire;
  company_name?: string;
  address_line_1?: string;
  address_line_2?: string;
  address_line_3?: string;
  carrier_code?: string;
  contact?: string;
  tel?: string;
  fax?: string;
  email?: string[];
}

export interface MultilingualStringWire {
  en?: string;
  fr?: string;
  es?: string;
  zh?: string;
  ru?: string;
  ar?: string;
}

export interface NNPActionWire {
  action_type?: string;
  position?: string;
  description?: string;
  entries?: NumberingPlanEntryWire[];
}

export interface NNPAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: NNPActionWire[];
}

export interface NumberingPlanEntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_code?: string;
  international_prefix?: string;
  national_prefix?: string;
  national_sig_number?: string;
  utc_dst?: string;
  note?: MultilingualStringWire;
}

export interface OldIssueWire {
  metadata?: IssueMetadataWire;
  general?: IssueGeneralWire;
  amendments?: AmendmentWire[];
}

export interface Q708ISPCActionWire {
  action_type?: string;
  position?: string;
  entries?: Q708ISPCEntryWire[];
  notes?: string;
}

export interface Q708ISPCAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: Q708ISPCActionWire[];
}

export interface Q708ISPCEntryWire {
  _class?: string;
  ipsc?: string;
  country?: MultilingualStringWire;
  dec?: string;
  signal_point_name?: string;
  signal_point_operator?: string;
}

export interface Q708SANCActionWire {
  action_type?: string;
  position?: string;
  entries?: Q708SANCEntryWire[];
  notes?: string;
  order?: string;
}

export interface Q708SANCAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: Q708SANCActionWire[];
}

export interface Q708SANCEntryWire {
  _class?: string;
  code?: string;
  area_or_network?: MultilingualStringWire;
  note?: MultilingualStringWire;
}

export interface RR251ActionWire {
  action_type?: string;
  position?: string;
  entries?: RR251EntryWire[];
  notes?: string;
}

export interface RR251AmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: RR251ActionWire[];
}

export interface RR251EntryWire {
  _class?: string;
  country_or_area?: MultilingualStringWire;
  country_or_area_note?: MultilingualStringWire;
  notes?: MultilingualStringWire;
  network_roa?: string;
  network_roa_note?: string;
  network_code?: string;
  network_code_note?: MultilingualStringWire;
  telegraph_office_name?: MultilingualStringWire;
  office_code?: string;
  office_code_note?: MultilingualStringWire;
  subarea?: MultilingualStringWire;
}

export interface T35AssignmentAuthorityWire {
  terminal_type?: string;
  contact_name?: string;
  organization?: string;
  department?: string;
  address?: string;
  telephone?: string;
  fax?: string;
  email?: string;
  related_links?: string[];
}

export interface T35NAActionWire {
  action_type?: string;
  position?: string;
  entries?: T35NAEntryWire[];
  notes?: string;
}

export interface T35NAAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: T35NAActionWire[];
}

export interface T35NAEntryWire {
  _class?: string;
  country?: string;
  administration_name?: string;
  manufactures_htv?: string;
  last_updated?: string;
  assignment_authority?: T35AssignmentAuthorityWire[];
  note?: string;
}

export interface TextActionWire {
  action_type?: string;
  position?: string;
}

export interface TextAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: TextActionWire[];
  dataset_code?: string;
  text?: string;
}

export interface X121DNICActionWire {
  action_type?: string;
  position?: string;
  country?: string;
  caption?: string;
  description?: string;
  entries?: X121DNICEntryWire[];
}

export interface X121DNICAmendmentWire {
  _class?: string;
  position_on?: string;
  notes?: string[];
  actions?: X121DNICActionWire[];
}

export interface X121DNICEntryWire {
  _class?: string;
  dnic_number?: string;
  country_or_area?: MultilingualStringWire;
  network_name?: string;
  note?: string;
}
