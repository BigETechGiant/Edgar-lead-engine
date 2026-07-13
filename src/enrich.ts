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
 * contact_phone, and LinkedIn discovery now — Claude no longer looks these up.
 *
 * The server-side web_search tool is only attached for high-value leads
 * (score >= WEB_SEARCH_MIN_SCORE); lower-scored leads are enriched from the
 * filing signal alone, with no web search cost.
 *
 * enrichment_status vocabulary (enum):
 *   unenriched | pending | enriched | partial | not_found | error
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import type { ScoredLead } from "./scoring.js";

/** Below this lead_score, enrich from the filing signal alone (no web_search). */
const WEB_SEARCH_MIN_SCORE = 75;

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

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
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

function collectText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function extractJson(text: string): RawProfile | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawProfile;
  } catch {
    return null;
  }
}

/** Enrich a single lead. Never throws — failures resolve to status "error". */
export async function enrichLead(lead: ScoredLead): Promise<EnrichmentResult> {
  if (!config.enrichmentEnabled) return blank("unenriched");

  try {
    const anthropic = getClient();
    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: buildUserPrompt(lead) },
    ];

    // web_search is expensive — only attach it for high-value leads. Lower-
    // scored leads are enriched from the filing signal alone, at no search cost.
    // Haiku 4.5 predates dynamic-filtering web_search (_20260209), so use the
    // basic tool version.
    const tools =
      lead.score >= WEB_SEARCH_MIN_SCORE
        ? [
            {
              type: "web_search_20250305" as const,
              name: "web_search" as const,
              max_uses: 2,
            },
          ]
        : [];

    const params = {
      model: "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM,
      tools,
      messages,
    };

    // Server-side web_search runs an internal loop; if it hits the iteration
    // cap it returns stop_reason "pause_turn" and we re-send to resume.
    let response = await anthropic.messages.create(params);
    let guard = 0;
    while (response.stop_reason === "pause_turn" && guard < 5) {
      messages.push({ role: "assistant", content: response.content });
      response = await anthropic.messages.create(params);
      guard++;
    }

    const raw = extractJson(collectText(response.content));
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
