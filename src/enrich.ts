/**
 * Light Claude enrichment layer.
 *
 * For each qualifying lead, Claude researches the company and returns intel
 * used to fill these edgar_leads columns:
 *   company_description, intelligence_summary, outreach_angle,
 *   contact_name, contact_title, website, enrichment_payload,
 *   enrichment_status.
 *
 * FullEnrich (via the Solventis Prospector dashboard) owns contact_email,
 * contact_phone, and LinkedIn discovery now — Claude no longer looks these up,
 * and no longer runs web_search: every call goes through the guarded
 * lib/claudeGuarded.ts wrapper, which has no tools/web_search surface at all.
 * Enrichment is filing-signal-only.
 *
 * enrichment_status vocabulary (enum):
 *   unenriched | pending | enriched | partial | not_found | error
 */
import { config } from "./config.js";
import { callClaude, parseJsonResponse } from "./lib/claudeGuarded.js";
import type { ScoredLead } from "./scoring.js";

export type EnrichmentStatus =
  | "unenriched"
  | "pending"
  | "enriched"
  | "partial"
  | "not_found"
  | "error";

export interface EnrichmentResult {
  status: EnrichmentStatus;
  companyDescription: string | null;
  intelligenceSummary: string | null;
  outreachAngle: string | null;
  contactName: string | null;
  contactTitle: string | null;
  website: string | null;
  /** Raw model JSON, persisted to enrichment_payload. */
  payload: unknown;
}

function blank(status: EnrichmentStatus, payload: unknown = null): EnrichmentResult {
  return {
    status,
    companyDescription: null,
    intelligenceSummary: null,
    outreachAngle: null,
    contactName: null,
    contactTitle: null,
    website: null,
    payload,
  };
}

const SYSTEM = `You are a research analyst for Solventis, a lower-middle-market investment bank.
Given a company that just made an SEC filing, research it and return a concise JSON profile to support outbound deal origination.
Be accurate and conservative: if you cannot verify a fact, use null rather than guessing.
Do not look up or guess a contact's email, phone number, or LinkedIn profile — that is handled by a separate enrichment step.
Respond with ONLY a single JSON object (no markdown, no prose) of exactly this shape:
{
  "found": boolean,                  // did you find a credible match for this company?
  "company_description": string|null,// 1-2 sentence description of what the company does
  "intelligence_summary": string|null,// 2-3 sentences of deal-relevant intel, INCLUDING any revenue signal with rough year
  "outreach_angle": string|null,     // ONE sentence: why Solventis should reach out now
  "contact_name": string|null,       // likely owner / CEO / key decision-maker
  "contact_title": string|null,
  "website": string|null             // official company website URL
}`;

const TRIGGER_BY_MONITOR: Record<string, string> = {
  reg_a: "filed a Reg A+ offering (Form 1-A/1-K), raising roughly $5M–$75M",
  s1_withdrawal:
    "WITHDREW its S-1 IPO registration (Form RW) — an abandoned IPO, a strong sell-side M&A signal",
  material_event: "filed an 8-K material event suggesting a possible transition",
};

function buildUserPrompt(lead: ScoredLead): string {
  const s = lead.signal;
  return [
    `Company: ${s.companyName || "(unknown)"}`,
    `SEC CIK: ${s.cik}`,
    `Location: ${[s.businessCity, s.bizState].filter(Boolean).join(", ") || "(unknown)"}`,
    `Sector: ${lead.sector}`,
    `Trigger: This company ${TRIGGER_BY_MONITOR[s.monitor] ?? "made a notable filing"}.`,
    `Filing: ${s.form} dated ${s.fileDate}. Implied service line: ${s.qualifiedService}.`,
    ``,
    `Research this specific company and return the JSON profile.`,
  ].join("\n");
}

interface RawProfile {
  found?: boolean;
  company_description?: string | null;
  intelligence_summary?: string | null;
  outreach_angle?: string | null;
  contact_name?: string | null;
  contact_title?: string | null;
  website?: string | null;
}

/** Enrich a single lead. Never throws — failures resolve to status "error". */
export async function enrichLead(lead: ScoredLead): Promise<EnrichmentResult> {
  if (!config.enrichmentEnabled) return blank("unenriched");

  try {
    const { text } = await callClaude({
      system: SYSTEM,
      prompt: buildUserPrompt(lead),
      maxTokens: 400,
    });

    const raw = parseJsonResponse<RawProfile>(text);
    if (!raw) {
      return blank("error", { parseError: true });
    }
    if (raw.found === false) {
      return { ...blank("not_found", raw) };
    }

    const result: EnrichmentResult = {
      status: "partial",
      companyDescription: raw.company_description ?? null,
      intelligenceSummary: raw.intelligence_summary ?? null,
      outreachAngle: raw.outreach_angle ?? null,
      contactName: raw.contact_name ?? null,
      contactTitle: raw.contact_title ?? null,
      website: raw.website ?? null,
      payload: raw,
    };

    // "enriched" when we have a contact AND substantive intel; else "partial";
    // "not_found" when nothing useful came back at all.
    const hasContact = Boolean(result.contactName);
    const hasIntel = Boolean(result.intelligenceSummary || result.outreachAngle);
    const hasAnything =
      hasContact ||
      hasIntel ||
      Boolean(result.companyDescription || result.website);

    if (hasContact && hasIntel) result.status = "enriched";
    else if (hasAnything) result.status = "partial";
    else result.status = "not_found";

    return result;
  } catch (err) {
    return blank("error", { error: (err as Error).message });
  }
}
