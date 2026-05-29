import type { CompanyProfile } from "./client.js";

export type MonitorKind = "reg_a" | "s1_withdrawal" | "material_event";

/** DB vocabulary for edgar_leads.qualified_service. */
export type QualifiedService =
  | "sell-side"
  | "buy-side"
  | "recap"
  | "refi"
  | "capital_raise"
  | "restructuring";

/** DB vocabulary for edgar_leads.signal_type. */
export type SignalType =
  | "reg_a_offering"
  | "s1_withdrawal"
  | "8k_material_event";

/**
 * Normalized lead signal emitted by a monitor, before scoring/enrichment.
 * Mapped to live edgar_leads columns in run.ts.
 */
export interface LeadSignal {
  source: "edgar";
  monitor: MonitorKind;
  signalType: SignalType;
  qualifiedService: QualifiedService;

  accessionNumber: string;
  cik: string;
  form: string; // "1-A" | "1-K" | "RW" | "8-K"
  fileDate: string; // YYYY-MM-DD
  periodOfReport: string; // YYYY-MM-DD or ""
  fileDescription: string;
  companyName: string;
  bizState: string;
  businessCity: string;
  sics: string[];

  /** Heuristic USD offering size used for SCORING only (Reg A+ band midpoint).
   *  This is NOT persisted as offering_amount — that column holds an actual
   *  filed amount, which we do not parse, so it stays null. */
  offeringSizeUsd: number | null;

  edgarUrl: string;
  profile: CompanyProfile | null;
}
