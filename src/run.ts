/**
 * Orchestrates a full run: scrape -> score -> upsert -> enrich -> log.
 *
 * - Each monitor runs independently and writes one lead_engine_runs row.
 * - Leads are upserted into edgar_leads on conflict of accession_number, so
 *   re-runs never duplicate, and only newly-INSERTED rows are enriched —
 *   existing leads are never re-sent to Claude.
 * - contact_email / contact_phone / LinkedIn are owned entirely by FullEnrich
 *   now; the enrichment layer no longer discovers or fills them.
 * - Claude enrichment is capped at MAX_ENRICHMENTS_PER_RUN per scheduled run
 *   to bound API cost; leads beyond the cap are still inserted (so no leads
 *   are lost) but stay unenriched until manually reprocessed.
 */
import { supabase } from "./supabase.js";
import { config } from "./config.js";
import { scoreLead, type ScoredLead } from "./scoring.js";
import { enrichLead } from "./enrich.js";
import {
  regAMonitor,
  withdrawalMonitor,
  materialEventMonitor,
} from "./edgar/monitors.js";
import type { LeadSignal, MonitorKind } from "./edgar/types.js";

/** Upsert rows in chunks so request bodies stay small. */
const UPSERT_CHUNK_SIZE = 50;

/** Hard cap on Claude enrichment calls across an entire scheduled run. */
const MAX_ENRICHMENTS_PER_RUN = 20;

/** lead_engine_runs.run_type vocabulary. */
type RunType = "reg_a" | "s1" | "8k";

interface MonitorDef {
  monitor: MonitorKind;
  runType: RunType;
  fn: () => Promise<LeadSignal[]>;
}

const MONITORS: MonitorDef[] = [
  { monitor: "reg_a", runType: "reg_a", fn: regAMonitor },
  { monitor: "s1_withdrawal", runType: "s1", fn: withdrawalMonitor },
  { monitor: "material_event", runType: "8k", fn: materialEventMonitor },
];

export interface MonitorSummary {
  monitor: MonitorKind;
  runType: RunType;
  filingsChecked: number;
  leadsFound: number;
  leadsNew: number;
  leadsDuplicate: number;
  error: string | null;
}

export interface RunSummary {
  startedAt: string;
  completedAt: string;
  filingsChecked: number;
  leadsFound: number;
  leadsNew: number;
  leadsDuplicate: number;
  monitors: MonitorSummary[];
}

function dateOrNull(s: string): string | null {
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

const DEFAULT_DESCRIPTION: Record<MonitorKind, string> = {
  reg_a: "Reg A+ offering filing",
  s1_withdrawal: "Registration withdrawal (Form RW)",
  material_event: "8-K material event",
};

/** Build the edgar_leads insert/upsert row — only the columns we are told to set. */
export function buildInsertRow(scored: ScoredLead): Record<string, unknown> {
  const s = scored.signal;
  const p = s.profile;
  return {
    company_name: s.companyName,
    cik: s.cik,
    accession_number: s.accessionNumber,
    filing_type: s.form,
    filing_date: dateOrNull(s.fileDate),
    period_of_report: dateOrNull(s.periodOfReport),
    filing_description: s.fileDescription || DEFAULT_DESCRIPTION[s.monitor],
    edgar_url: s.edgarUrl,
    sic_code: p?.sic || s.sics[0] || null,
    sic_description: p?.sicDescription || null,
    sector: scored.sector,
    state_of_incorporation: p?.stateOfIncorporation || null,
    business_state: s.bizState || null,
    business_city: s.businessCity || null,
    phone: p?.phone || null,
    // offering_amount holds an ACTUAL filed amount; we do not parse it -> null.
    offering_amount: null,
    estimated_revenue: null,
    employee_count: null,
    signal_type: s.signalType,
    lead_score: scored.score,
    score_breakdown: scored.breakdown,
    qualified_service: s.qualifiedService,
    status: "new",
    raw_data: {
      source: s.source,
      monitor: s.monitor,
      signal_type: s.signalType,
      accession_number: s.accessionNumber,
      cik: s.cik,
      form: s.form,
      file_date: s.fileDate,
      period_of_report: s.periodOfReport,
      file_description: s.fileDescription,
      company_name: s.companyName,
      business_state: s.bizState,
      business_city: s.businessCity,
      sics: s.sics,
      edgar_url: s.edgarUrl,
      profile: p,
    },
    // NOTE: id, created_at, updated_at, enrichment_status, contact_email,
    // contact_phone are intentionally NOT set here.
  };
}

interface UpsertedRow {
  id: string | number;
  accession_number: string;
}

/** Apply Claude enrichment to a single new lead and update it by id. */
async function enrichAndUpdate(
  scored: ScoredLead,
  row: UpsertedRow
): Promise<void> {
  const e = await enrichLead(scored);

  const update: Record<string, unknown> = {
    company_description: e.companyDescription,
    intelligence_summary: e.intelligenceSummary,
    outreach_angle: e.outreachAngle,
    contact_name: e.contactName,
    contact_title: e.contactTitle,
    website: e.website,
    enriched_at: new Date().toISOString(),
    enrichment_payload: e.payload,
    enrichment_status: e.status,
  };

  const { error } = await supabase
    .from("edgar_leads")
    .update(update)
    .eq("id", row.id);
  if (error) {
    console.error(
      `[enrich] update failed for ${row.accession_number}: ${error.message}`
    );
  }
}

/** Shared across monitors within one runFullRun() call. */
interface EnrichmentBudget {
  remaining: number;
}

async function runMonitor(
  def: MonitorDef,
  budget: EnrichmentBudget
): Promise<MonitorSummary> {
  const summary: MonitorSummary = {
    monitor: def.monitor,
    runType: def.runType,
    filingsChecked: 0,
    leadsFound: 0,
    leadsNew: 0,
    leadsDuplicate: 0,
    error: null,
  };

  try {
    const signals = await def.fn();
    summary.filingsChecked = signals.length;

    const qualifying = signals
      .map(scoreLead)
      .filter((s) => s.score >= config.minLeadScore);
    summary.leadsFound = qualifying.length;

    if (qualifying.length > 0) {
      // Dedupe at the DB level: upsert on accession_number (unique) with
      // ignoreDuplicates, so the DB decides new-vs-duplicate. No pre-check
      // SELECT. Chunk the upsert so request bodies stay small.
      const byAccessionQ = new Map<string, ScoredLead>();
      for (const q of qualifying) {
        byAccessionQ.set(q.signal.accessionNumber, q);
      }

      const rows = qualifying.map(buildInsertRow);
      const insertedRows: UpsertedRow[] = [];

      for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
        const { data: upserted, error: upsertErr } = await supabase
          .from("edgar_leads")
          .upsert(chunk, {
            onConflict: "accession_number",
            ignoreDuplicates: true,
          })
          .select("id, accession_number");
        if (upsertErr) {
          throw new Error(
            `upsert failed (chunk ${i / UPSERT_CHUNK_SIZE}): ${upsertErr.message}`
          );
        }
        // With ignoreDuplicates, only NEWLY inserted rows are returned.
        for (const r of (upserted ?? []) as UpsertedRow[]) {
          insertedRows.push(r);
        }
      }

      // leadsNew = rows the upsert actually INSERTED (summed across chunks).
      summary.leadsNew = insertedRows.length;
      summary.leadsDuplicate = qualifying.length - summary.leadsNew;

      // Enrich only the NEW (just-inserted) leads, capped by the run-wide
      // enrichment budget. Highest-scored leads get priority under the cap;
      // any leads left over stay inserted but unenriched.
      const toEnrich = [...insertedRows].sort((a, b) => {
        const scoreA = byAccessionQ.get(a.accession_number)?.score ?? 0;
        const scoreB = byAccessionQ.get(b.accession_number)?.score ?? 0;
        return scoreB - scoreA;
      });

      if (toEnrich.length > budget.remaining) {
        console.warn(
          `[run:${def.monitor}] enrichment cap hit: ${toEnrich.length} new leads, ` +
            `only ${budget.remaining} of ${MAX_ENRICHMENTS_PER_RUN} run-wide slots left — ` +
            `${toEnrich.length - budget.remaining} lead(s) inserted but left unenriched.`
        );
      }

      for (const row of toEnrich) {
        if (budget.remaining <= 0) break;
        const q = byAccessionQ.get(row.accession_number);
        if (!q) continue;
        await enrichAndUpdate(q, row);
        budget.remaining--;
      }
    }
  } catch (err) {
    summary.error = (err as Error).message;
    console.error(`[run:${def.monitor}] ${summary.error}`);
  }

  // Log this monitor's run regardless of outcome.
  const { error: logErr } = await supabase.from("lead_engine_runs").insert({
    source: "edgar",
    run_type: def.runType,
    filings_checked: summary.filingsChecked,
    leads_found: summary.leadsFound,
    leads_new: summary.leadsNew,
    leads_duplicate: summary.leadsDuplicate,
    error: summary.error,
    completed_at: new Date().toISOString(),
  });
  if (logErr) {
    console.error(`[run:${def.monitor}] run-log insert failed: ${logErr.message}`);
  }

  return summary;
}

/** Run all three monitors sequentially and return an aggregate summary. */
export async function runFullRun(): Promise<RunSummary> {
  const startedAt = new Date().toISOString();
  const monitors: MonitorSummary[] = [];
  const budget: EnrichmentBudget = { remaining: MAX_ENRICHMENTS_PER_RUN };

  for (const def of MONITORS) {
    monitors.push(await runMonitor(def, budget));
  }

  const agg = monitors.reduce(
    (a, m) => {
      a.filingsChecked += m.filingsChecked;
      a.leadsFound += m.leadsFound;
      a.leadsNew += m.leadsNew;
      a.leadsDuplicate += m.leadsDuplicate;
      return a;
    },
    { filingsChecked: 0, leadsFound: 0, leadsNew: 0, leadsDuplicate: 0 }
  );

  return {
    startedAt,
    completedAt: new Date().toISOString(),
    ...agg,
    monitors,
  };
}
