/**
 * WHAT EVERY DEAL TYPE REQUIRES, AT EVERY STATUS - TD-159.
 *
 * Transcribed from the brokerage's own master sheet, approved 2026-09-23
 * ("GHR-DOCUMENT-CHECKLISTS-MASTER-Sep 23, 2026.xlsx"), INCLUDING the remarks written on it. It is
 * their list, not an invented one - the same standard TD-149 set for the type-only defaults this
 * replaces, and for the same reason: which documents a brokerage must hold is a RECO question with
 * a real answer, and inventing one would put a compliance assertion into the product on no
 * authority.
 *
 * HOW IT WAS PRODUCED, recorded because the first attempt got this wrong: it applied three of the
 * sixty-seven removals and was then "verified" against its own working copy rather than against the
 * sheet, so the check passed on a faithful copy of the mistake. The sheet is now read in one pass by
 * a script that applies each remark by its exact text and REFUSES TO RUN on a remark it does not
 * recognise. Of the 890 lines the brokerage returned: 76 removed, 30 raised to Mandatory, 10 lowered
 * to Non-Mandatory, leaving the 814 below. The six renames from the sheet's own name tab are applied
 * (ATL, ATL Commercial, Cancellation / Termination Document, NOF, NOS, ORTA / OSL).
 *
 * TWO JUDGEMENT CALLS, made on the brokerage's instruction to decide from the sheet, written down
 * so either can be overturned by pointing at this comment:
 *   1. MLS Sheet-Final is NOT required while a listing is still conditional. The remark naming
 *      where it belongs ("keep in 'Sold' & 'Closed'") was written ON the conditional row, and in
 *      this sheet a remark on a row always means that row changes - untouched rows say "Approved".
 *      The conditional stages already carry MLS Draft Sheet and MLS Data Information Form.
 *   2. Schedule A IS Mandatory on the two lease listing types at six statuses, although the name tab
 *      calls Schedule A non-mandatory everywhere. The per-row instruction wins: it was written
 *      twelve times, consistently across both lease listing types, while Schedule A was REMOVED
 *      outright on the sale listing side. That is a deliberate difference, not a slip.
 *
 * NOT HERE, DELIBERATELY: Business Sale, which the brokerage excluded ("ignore for now"); the
 * interlink rules between Amendment, Notice of Fulfilment and Waiver; and what happens to a
 * checklist when a status CHANGES, which their remarks make depend on where the deal came from.
 * Those are behaviour, not lists, and they arrive with their own code and their own tests.
 */

/** Every document name the brokerage uses, spelled once. */
export const DOC = {
  OFFER_SUMMARY: 'Offer Summary Document',
  APS: 'Agreement of Purchase and Sale (APS)',
  SCHEDULE_B: 'Schedule B',
  COOP: 'Confirmation of Co-operation and Representation',
  AMENDMENT: 'Amendment',
  BUYER_REP: 'Buyer Representation Agreement',
  DEPOSIT_RECEIPT: 'Deposit Receipt',
  CLIENT_IDS: "Client Photo ID's",
  FINTRAC: 'Fintrac',
  RECO: 'RECO Information Guide',
  SCHEDULE_A: 'Schedule A',
  NOF: 'Notice of Fulfilment (NOF)',
  WAIVER: 'Waiver',
  NOS: 'Notice of Sale (NOS)',
  TRADE_SHEET: 'Trade Record Sheet',
  MLS_FINAL: 'MLS Sheet-Final',
  MUTUAL_RELEASE: 'Mutual Release',
  RENTAL_APPLICATION: 'Rental Application',
  ATL: 'Agreement to Lease (ATL)',
  TENANT_REP: 'Tenant Representation Agreement',
  ORTA: 'ORTA / OSL',
  ATL_COMMERCIAL: 'Agreement to Lease - Commercial (ATL)',
  ATL_LONG: 'Form 510 - Agreement to Lease Commercial (Long Form)',
  ATL_SHORT: 'Form 511 - Agreement to Lease Commercial (Short Form)',
  LISTING_AGREEMENT: 'Listing Agreement',
  MLS_DRAFT: 'MLS Draft Sheet',
  MLS_DATA_FORM: 'MLS Data Information Form',
  SELLERS_DIRECTION: "Seller's Direction",
  DISCLOSURE: 'Disclosure',
  LISTING_AMENDMENT: 'Listing Amendment',
  CANCELLATION: 'Cancellation / Termination Document',
  BROKER_REFERRAL: 'Broker Referral',
  DEPOSIT_CHEQUE: 'Deposit Cheque',
  REFERRAL_AGREEMENT: 'Referral Agreement',
} as const;

/**
 * Documents that satisfy each other - TD-159 slice 3.
 *
 * Upload any ONE member of a group and the rest stop being required, WHILE STAYING ON SCREEN. Both
 * names come straight from the brokerage's remarks: 'Interlink with ... ; if one of these Documents
 * uploaded, rest 2 remain Non-Mandatory' and 'Either this or the other sub-document. Both Mandatory
 * until ONE is uploaded; the other then becomes Non-Mandatory.'
 */
export const PROOF_OF_CONDITION = 'condition-proof';
export const ATL_FORM = 'atl-form';

export interface ChecklistItem {
  title: string;
  mandatory: boolean;
  /** Set on the two commercial Agreement to Lease forms: either satisfies the parent. */
  parent?: string;
  /** Members of the same group satisfy each other. See PROOF_OF_CONDITION / ATL_FORM. */
  group?: string;
}

const M = (title: string): ChecklistItem => ({ title, mandatory: true });
const N = (title: string): ChecklistItem => ({ title, mandatory: false });
const MG = (title: string, group: string): ChecklistItem => ({ title, mandatory: true, group });
const NG = (title: string, group: string): ChecklistItem => ({ title, mandatory: false, group });
const SUB = (title: string, parent: string): ChecklistItem =>
  ({ title, mandatory: true, parent, group: ATL_FORM });

type StatusLists = Record<string, ChecklistItem[]>;

/** Residential Buying / Business Buying / Commercial Property Buying */
const BUYING: StatusLists = {
  'Secured Firm': [M(DOC.OFFER_SUMMARY), M(DOC.APS), N(DOC.SCHEDULE_B), M(DOC.COOP), N(DOC.AMENDMENT),
    M(DOC.BUYER_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS), M(DOC.FINTRAC), M(DOC.RECO), N(DOC.SCHEDULE_A)],
  'Secured Conditional': [M(DOC.OFFER_SUMMARY), M(DOC.APS), N(DOC.SCHEDULE_B),
    NG(DOC.AMENDMENT, PROOF_OF_CONDITION), MG(DOC.NOF, PROOF_OF_CONDITION), MG(DOC.WAIVER, PROOF_OF_CONDITION),
    M(DOC.COOP), M(DOC.BUYER_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS), M(DOC.FINTRAC), M(DOC.RECO),
    N(DOC.SCHEDULE_A)],
  'Closed': [M(DOC.OFFER_SUMMARY), M(DOC.APS), N(DOC.SCHEDULE_B), N(DOC.AMENDMENT), M(DOC.NOF), M(DOC.WAIVER),
    M(DOC.COOP), M(DOC.BUYER_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS), M(DOC.FINTRAC), M(DOC.RECO),
    M(DOC.NOS), M(DOC.TRADE_SHEET), M(DOC.MLS_FINAL), N(DOC.SCHEDULE_A)],
  'Mutual Release': [M(DOC.APS), M(DOC.DEPOSIT_RECEIPT), M(DOC.MUTUAL_RELEASE)],
  'DFT': [M(DOC.APS)],
  'Void': [M(DOC.APS)],
};

/** Residential Lease */
const RESIDENTIAL_LEASE: StatusLists = {
  'Secured Firm': [N(DOC.OFFER_SUMMARY), N(DOC.RENTAL_APPLICATION), M(DOC.ATL), N(DOC.SCHEDULE_B), M(DOC.COOP),
    N(DOC.AMENDMENT), M(DOC.TENANT_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS), M(DOC.FINTRAC), M(DOC.RECO),
    N(DOC.SCHEDULE_A)],
  'Secured Conditional': [N(DOC.OFFER_SUMMARY), N(DOC.RENTAL_APPLICATION), M(DOC.ATL), N(DOC.SCHEDULE_B),
    NG(DOC.AMENDMENT, PROOF_OF_CONDITION), MG(DOC.NOF, PROOF_OF_CONDITION), MG(DOC.WAIVER, PROOF_OF_CONDITION),
    M(DOC.COOP), M(DOC.TENANT_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS), M(DOC.FINTRAC), M(DOC.RECO),
    N(DOC.SCHEDULE_A)],
  'Closed': [N(DOC.OFFER_SUMMARY), N(DOC.RENTAL_APPLICATION), M(DOC.ATL), N(DOC.SCHEDULE_B), N(DOC.AMENDMENT),
    M(DOC.NOF), M(DOC.WAIVER), M(DOC.COOP), M(DOC.TENANT_REP), M(DOC.DEPOSIT_RECEIPT), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), M(DOC.RECO), M(DOC.ORTA), M(DOC.NOS), M(DOC.TRADE_SHEET), M(DOC.MLS_FINAL), N(DOC.SCHEDULE_A)],
  'Mutual Release': [M(DOC.ATL), M(DOC.DEPOSIT_RECEIPT), M(DOC.MUTUAL_RELEASE)],
  'DFT': [M(DOC.ATL)],
  'Void': [M(DOC.ATL)],
};

/** Commercial Property Lease */
const COMMERCIAL_LEASE: StatusLists = {
  'Secured Firm': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL),
    SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL), M(DOC.COOP), M(DOC.TENANT_REP), M(DOC.RECO), N(DOC.AMENDMENT),
    N(DOC.SCHEDULE_A)],
  'Secured Conditional': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL),
    SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL), M(DOC.COOP), M(DOC.TENANT_REP), M(DOC.RECO),
    NG(DOC.WAIVER, PROOF_OF_CONDITION), NG(DOC.NOF, PROOF_OF_CONDITION), NG(DOC.AMENDMENT, PROOF_OF_CONDITION),
    N(DOC.SCHEDULE_A)],
  'Closed': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL), SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL),
    M(DOC.COOP), M(DOC.TENANT_REP), M(DOC.RECO), M(DOC.MLS_FINAL), N(DOC.WAIVER), N(DOC.NOF), N(DOC.AMENDMENT),
    M(DOC.FINTRAC), M(DOC.NOS), M(DOC.TRADE_SHEET), N(DOC.SCHEDULE_A)],
  'Mutual Release': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL),
    SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL), M(DOC.COOP), M(DOC.MUTUAL_RELEASE), N(DOC.DEPOSIT_RECEIPT)],
  'DFT': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL), SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL),
    M(DOC.COOP)],
  'Void': [M(DOC.ATL_COMMERCIAL), SUB(DOC.ATL_LONG, DOC.ATL_COMMERCIAL), SUB(DOC.ATL_SHORT, DOC.ATL_COMMERCIAL),
    M(DOC.COOP)],
};

/** Residential Sale Listing / Commercial Property Sale Listing */
const SALE_LISTING: StatusLists = {
  'Active': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS), M(DOC.FINTRAC),
    N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT)],
  'Sold Conditional': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    M(DOC.OFFER_SUMMARY), M(DOC.APS), M(DOC.SCHEDULE_B), NG(DOC.AMENDMENT, PROOF_OF_CONDITION),
    MG(DOC.NOF, PROOF_OF_CONDITION), MG(DOC.WAIVER, PROOF_OF_CONDITION), M(DOC.COOP), M(DOC.DEPOSIT_RECEIPT),
    N(DOC.SCHEDULE_A)],
  'Sold': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    M(DOC.OFFER_SUMMARY), M(DOC.APS), M(DOC.SCHEDULE_B), N(DOC.AMENDMENT), M(DOC.NOF), M(DOC.WAIVER), M(DOC.COOP),
    M(DOC.DEPOSIT_RECEIPT), M(DOC.TRADE_SHEET), M(DOC.NOS), N(DOC.SCHEDULE_A)],
  'Closed': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    M(DOC.OFFER_SUMMARY), M(DOC.APS), M(DOC.SCHEDULE_B), N(DOC.AMENDMENT), M(DOC.NOF), M(DOC.WAIVER), M(DOC.COOP),
    M(DOC.DEPOSIT_RECEIPT), M(DOC.TRADE_SHEET), M(DOC.NOS), N(DOC.SCHEDULE_A)],
  'Mutual Release': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.APS),
    M(DOC.DEPOSIT_RECEIPT), M(DOC.MUTUAL_RELEASE)],
  'DFT': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.APS)],
  'Void': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS), N(DOC.FINTRAC),
    N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.APS)],
  'Suspended': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT)],
  'Terminated': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL),
    M(DOC.CLIENT_IDS), N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO),
    N(DOC.LISTING_AMENDMENT), M(DOC.CANCELLATION)],
  'Expired': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL),
    M(DOC.CLIENT_IDS), N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO),
    N(DOC.LISTING_AMENDMENT)],
};

/** Residential Lease Listing / Commercial Property Lease Listing */
const LEASE_LISTING: StatusLists = {
  'Active': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS), M(DOC.FINTRAC),
    N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT)],
  'Lease Conditional': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    N(DOC.OFFER_SUMMARY), M(DOC.ATL), M(DOC.SCHEDULE_B), NG(DOC.AMENDMENT, PROOF_OF_CONDITION),
    MG(DOC.NOF, PROOF_OF_CONDITION), MG(DOC.WAIVER, PROOF_OF_CONDITION), M(DOC.COOP), M(DOC.DEPOSIT_RECEIPT),
    M(DOC.SCHEDULE_A)],
  'Leased': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    N(DOC.OFFER_SUMMARY), M(DOC.ATL), M(DOC.SCHEDULE_B), N(DOC.AMENDMENT), M(DOC.NOF), M(DOC.WAIVER), M(DOC.COOP),
    M(DOC.DEPOSIT_RECEIPT), N(DOC.RENTAL_APPLICATION), M(DOC.TRADE_SHEET), M(DOC.NOS), M(DOC.ORTA),
    M(DOC.SCHEDULE_A)],
  'Closed': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    M(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT),
    N(DOC.OFFER_SUMMARY), M(DOC.ATL), M(DOC.SCHEDULE_B), N(DOC.AMENDMENT), M(DOC.NOF), M(DOC.WAIVER), M(DOC.COOP),
    M(DOC.DEPOSIT_RECEIPT), N(DOC.RENTAL_APPLICATION), M(DOC.TRADE_SHEET), M(DOC.NOS), M(DOC.ORTA),
    M(DOC.SCHEDULE_A)],
  'Mutual Release': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.ATL),
    M(DOC.DEPOSIT_RECEIPT), M(DOC.MUTUAL_RELEASE), M(DOC.SCHEDULE_B), M(DOC.SCHEDULE_A)],
  'DFT': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.ATL),
    M(DOC.SCHEDULE_B), M(DOC.SCHEDULE_A)],
  'Void': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS), N(DOC.FINTRAC),
    N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT), M(DOC.ATL),
    M(DOC.SCHEDULE_B), M(DOC.SCHEDULE_A)],
  'Suspended': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.CLIENT_IDS),
    N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO), N(DOC.LISTING_AMENDMENT)],
  'Terminated': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL),
    M(DOC.CLIENT_IDS), N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO),
    N(DOC.LISTING_AMENDMENT), M(DOC.CANCELLATION)],
  'Expired': [M(DOC.LISTING_AGREEMENT), M(DOC.MLS_DRAFT), M(DOC.MLS_DATA_FORM), M(DOC.MLS_FINAL),
    M(DOC.CLIENT_IDS), N(DOC.FINTRAC), N(DOC.SELLERS_DIRECTION), N(DOC.DISCLOSURE), M(DOC.RECO),
    N(DOC.LISTING_AMENDMENT)],
};

/** Preconstruction */
const PRECONSTRUCTION: StatusLists = {
  'Secured Firm': [M(DOC.APS), M(DOC.BROKER_REFERRAL), N(DOC.DEPOSIT_CHEQUE), N(DOC.CLIENT_IDS), N(DOC.RECO),
    N(DOC.AMENDMENT), N(DOC.BUYER_REP)],
  'Secured Conditional': [M(DOC.APS), M(DOC.BROKER_REFERRAL), N(DOC.DEPOSIT_CHEQUE), N(DOC.CLIENT_IDS),
    N(DOC.RECO), N(DOC.AMENDMENT), N(DOC.NOF), N(DOC.WAIVER), N(DOC.BUYER_REP), N(DOC.SCHEDULE_A)],
  'Closed': [M(DOC.APS), M(DOC.BROKER_REFERRAL), N(DOC.DEPOSIT_CHEQUE), N(DOC.CLIENT_IDS), N(DOC.RECO),
    N(DOC.AMENDMENT), N(DOC.BUYER_REP), M(DOC.NOS), M(DOC.TRADE_SHEET)],
  'Mutual Release': [M(DOC.APS), M(DOC.MUTUAL_RELEASE)],
  'DFT': [M(DOC.APS)],
  'Void': [M(DOC.APS)],
};

/** Referral */
const REFERRAL: StatusLists = {
  'Open': [M(DOC.REFERRAL_AGREEMENT), M(DOC.NOS), M(DOC.TRADE_SHEET)],
  'Closed': [M(DOC.REFERRAL_AGREEMENT), M(DOC.NOS), M(DOC.TRADE_SHEET)],
};

/** Which family a deal type follows. Business Sale is absent on purpose - see the header. */
const FAMILY_OF: Record<string, StatusLists> = {
  'Residential Buying': BUYING,
  'Business Buying': BUYING,
  'Commercial Property Buying': BUYING,
  'Residential Lease': RESIDENTIAL_LEASE,
  'Commercial Property Lease': COMMERCIAL_LEASE,
  'Residential Sale Listing': SALE_LISTING,
  'Commercial Property Sale Listing': SALE_LISTING,
  'Residential Lease Listing': LEASE_LISTING,
  'Commercial Property Lease Listing': LEASE_LISTING,
  'Preconstruction': PRECONSTRUCTION,
  'Referral': REFERRAL,
};

/**
 * The list a deal of this type and status requires, or [] when the brokerage has not given one.
 *
 * AN EMPTY ANSWER IS LEFT EMPTY, as the type-only defaults did before this: writing even one row
 * would make the checklist non-empty for ever, so the lazy seed could never repair it and
 * correcting the type later would no longer help. Business Sale, a blank type and a status outside
 * the type's own vocabulary all land here.
 */
export function checklistFor(type: string | null | undefined, status: string | null | undefined): ChecklistItem[] {
  const lists = FAMILY_OF[String(type ?? '').trim()];
  if (!lists) return [];
  const items = lists[String(status ?? '').trim()];
  // A FRESH COPY EVERY TIME. The lists above are module state shared by every request, and callers
  // sort and annotate what they are handed - one of them mutating the answer would quietly rewrite
  // the brokerage's checklist for the whole process, and every deal made afterwards would inherit
  // the damage with nothing to show where it came from.
  return items ? items.map((item) => ({ ...item })) : [];
}

/**
 * The interlink groups on this type/status, as { group: [titles] }. Empty when none apply.
 *
 * Read by the rule that relaxes a group once one of its members has a file. A group with fewer than
 * two members is left out - one document cannot satisfy itself, and returning it would invite a
 * caller to treat a lone row as optional.
 */
export function interlinkGroupsFor(type: string | null | undefined, status: string | null | undefined): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const item of checklistFor(type, status)) {
    if (item.group) (groups[item.group] ??= []).push(item.title);
  }
  for (const [name, titles] of Object.entries(groups)) if (titles.length < 2) delete groups[name];
  return groups;
}

/**
 * The statuses this type has a list for, IN THE ORDER THE BROKERAGE WROTE THEM, which is the order a
 * deal moves through them. Used to pick which status governs when a deal holds more than one.
 */
export function statusesDefinedFor(type: string | null | undefined): string[] {
  const lists = FAMILY_OF[String(type ?? '').trim()];
  return lists ? Object.keys(lists) : [];
}

/** Every type/status pair the brokerage defined, for the tests and the rebuild tooling. */
export function everyChecklist(): { type: string; status: string; items: ChecklistItem[] }[] {
  const out: { type: string; status: string; items: ChecklistItem[] }[] = [];
  for (const [type, lists] of Object.entries(FAMILY_OF)) {
    for (const status of Object.keys(lists)) out.push({ type, status, items: checklistFor(type, status) });
  }
  return out;
}
