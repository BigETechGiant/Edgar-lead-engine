/**
 * The three EDGAR monitors. Each returns normalized LeadSignal[].
 *
 *  • Reg A+         — Form 1-A / 1-K (companies raising $5M–$75M)
 *  • S-1 withdrawal — Form RW (failed IPO candidates; strongest M&A signal)
 *  • 8-K material   — material events in target sectors (transition signals)
 *
 * Each monitor runs a form-filtered full-text search over the lookback window,
 * then enriches every hit with the company submissions profile (state / SIC).
 */
import {
  fullTextSearch,
  getCompanyProfile,
  edgarFilingUrl,
  type FtsHit,
} from "./client.js";
import { anyTargetSic } from "./sectors.js";
import type {
  LeadSignal,
  MonitorKind,
  QualifiedService,
  SignalType,
} from "./types.js";
import { config } from "../config.js";

/** YYYY-MM-DD for `daysAgo` days before now, and today. */
export function lookbackWindow(days: number): {
  startdt: string;
  enddt: string;
} {
  const now = new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startdt: fmt(start), enddt: fmt(now) };
}

/** "ACME CORP (CIK 0001234567)" -> "ACME CORP" */
function cleanCompanyName(displayName: string): string {
  return displayName.replace(/\s*\(CIK\s*\d+\)\s*$/i, "").trim();
}

interface MonitorSpec {
  monitor: MonitorKind;
  signalType: SignalType;
  qualifiedService: QualifiedService;
  offeringSizeUsd: number | null;
}

/** Turn a raw FTS hit into a LeadSignal, fetching the company profile. */
async function toSignal(hit: FtsHit, spec: MonitorSpec): Promise<LeadSignal> {
  let profile = null;
  try {
    profile = await getCompanyProfile(hit.cik);
  } catch (err) {
    console.warn(
      `[monitor:${spec.monitor}] profile fetch failed for CIK ${hit.cik}: ${
        (err as Error).message
      }`
    );
  }

  const bizState = profile?.businessState || hit.bizStates[0] || "";
  const sics =
    hit.sics.length > 0 ? hit.sics : profile?.sic ? [profile.sic] : [];

  return {
    source: "edgar",
    monitor: spec.monitor,
    signalType: spec.signalType,
    qualifiedService: spec.qualifiedService,
    accessionNumber: hit.accessionNumber,
    cik: hit.cik,
    form: hit.form,
    fileDate: hit.fileDate,
    periodOfReport: hit.periodOfReport,
    fileDescription: hit.fileDescription,
    companyName: cleanCompanyName(hit.displayName) || profile?.name || "",
    bizState,
    businessCity: profile?.businessCity || "",
    sics,
    offeringSizeUsd: spec.offeringSizeUsd,
    edgarUrl: edgarFilingUrl(hit.cik, hit.accessionNumber),
    profile,
  };
}

/** De-duplicate hits by accession number (FTS returns one row per document). */
function dedupeByAccession(hits: FtsHit[]): FtsHit[] {
  const seen = new Set<string>();
  const out: FtsHit[] = [];
  for (const h of hits) {
    if (h.accessionNumber && !seen.has(h.accessionNumber)) {
      seen.add(h.accessionNumber);
      out.push(h);
    }
  }
  return out;
}

// --- Reg A+ : Form 1-A and 1-K ------------------------------------------------
// Reg A+ band is $5M–$75M; use the midpoint as the (scoring-only) size signal.
const REG_A_MIDPOINT = 40_000_000;

export async function regAMonitor(): Promise<LeadSignal[]> {
  const { startdt, enddt } = lookbackWindow(config.lookbackDays);
  const hits = dedupeByAccession(
    await fullTextSearch({ forms: "1-A,1-K", startdt, enddt })
  );
  const spec: MonitorSpec = {
    monitor: "reg_a",
    signalType: "reg_a_offering",
    qualifiedService: "capital_raise",
    offeringSizeUsd: REG_A_MIDPOINT,
  };
  const signals: LeadSignal[] = [];
  for (const h of hits) signals.push(await toSignal(h, spec));
  return signals;
}

// --- S-1 withdrawals : Form RW ------------------------------------------------
export async function withdrawalMonitor(): Promise<LeadSignal[]> {
  const { startdt, enddt } = lookbackWindow(config.lookbackDays);
  const hits = dedupeByAccession(
    await fullTextSearch({ forms: "RW", startdt, enddt })
  );
  // Failed IPO candidate -> strongest sell-side M&A signal.
  const spec: MonitorSpec = {
    monitor: "s1_withdrawal",
    signalType: "s1_withdrawal",
    qualifiedService: "sell-side",
    offeringSizeUsd: null,
  };
  const signals: LeadSignal[] = [];
  for (const h of hits) signals.push(await toSignal(h, spec));
  return signals;
}

// --- 8-K material events in target sectors -----------------------------------
export async function materialEventMonitor(): Promise<LeadSignal[]> {
  const { startdt, enddt } = lookbackWindow(config.lookbackDays);
  // 8-K is very high volume; cap pages and filter to target sectors at the
  // hit level (FTS hits carry the SIC) before spending profile fetches.
  const hits = dedupeByAccession(
    await fullTextSearch({ forms: "8-K", startdt, enddt, maxPages: 20 })
  ).filter((h) => anyTargetSic(h.sics));

  const spec: MonitorSpec = {
    monitor: "material_event",
    signalType: "8k_material_event",
    qualifiedService: "sell-side",
    offeringSizeUsd: null,
  };
  const signals: LeadSignal[] = [];
  for (const h of hits) signals.push(await toSignal(h, spec));
  return signals;
}
