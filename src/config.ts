/**
 * Environment loading + validation.
 *
 * Every value comes from process.env. PORT is injected by Railway and is the
 * only var we do not require to be present (defaults to 3000 for local dev).
 */
import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v.trim();
}

function optional(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function csv(name: string): string[] {
  return optional(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Config {
  port: number;

  supabaseUrl: string;
  supabaseServiceRoleKey: string;

  anthropicApiKey: string;

  edgarUserAgent: string;
  edgarEngineKey: string;

  minLeadScore: number;
  lookbackDays: number;

  postalEndpoint: string;
  postalApiKey: string;
  digestTo: string[];
  digestCc: string[];
  digestFrom: string;

  /** True when the enrichment layer has what it needs. */
  enrichmentEnabled: boolean;
  /** True when the digest mailer has what it needs. */
  digestEnabled: boolean;
}

/** Hard-required for the server to boot at all. */
const cfg: Config = {
  port: intEnv("PORT", 3000),

  supabaseUrl: required("SUPABASE_URL").replace(/\/+$/, ""),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),

  anthropicApiKey: optional("ANTHROPIC_API_KEY"),

  edgarUserAgent: required("EDGAR_USER_AGENT"),
  edgarEngineKey: required("EDGAR_ENGINE_KEY"),

  minLeadScore: intEnv("MIN_LEAD_SCORE", 40),
  lookbackDays: intEnv("LOOKBACK_DAYS", 7),

  postalEndpoint: optional("POSTAL_ENDPOINT"),
  postalApiKey: optional("POSTAL_API_KEY"),
  digestTo: csv("DIGEST_TO"),
  digestCc: csv("DIGEST_CC"),
  digestFrom: optional("DIGEST_FROM"),

  enrichmentEnabled: false,
  digestEnabled: false,
};

cfg.enrichmentEnabled = cfg.anthropicApiKey !== "";
cfg.digestEnabled =
  cfg.postalEndpoint !== "" &&
  cfg.postalApiKey !== "" &&
  cfg.digestFrom !== "" &&
  cfg.digestTo.length > 0;

if (!cfg.enrichmentEnabled) {
  console.warn(
    "[config] ANTHROPIC_API_KEY not set — enrichment layer will be skipped (leads marked 'unenriched')."
  );
}
if (!cfg.digestEnabled) {
  console.warn(
    "[config] Postal/digest vars incomplete — daily digest email will be skipped."
  );
}

export const config = cfg;

/** High-priority threshold per spec (>= 65). */
export const HIGH_PRIORITY_SCORE = 65;
