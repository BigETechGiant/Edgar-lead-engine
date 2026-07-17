/**
 * Self-contained guarded wrapper around the Anthropic SDK.
 *
 * This is the ONLY function in the repo allowed to call anthropic.messages.create().
 * Every caller gets, with no way to opt out:
 *   - model hard-locked to claude-haiku-4-5 — not a parameter, so nothing can
 *     ever point this at Sonnet or Opus
 *   - max_tokens hard-capped at MAX_TOKENS_CEILING regardless of what's requested
 *   - no tools / web_search support — contact + web lookups are FullEnrich's
 *     job now, not Claude's (see src/enrich.ts header comment)
 *   - a per-call cost estimate, logged to stdout
 *   - a per-run cost accumulator (resetCostTracking / getCostSummary) so the
 *     caller can emit one resolved-model + estimated-cost line per run
 *
 * Callers should write lean, JSON-only system prompts ("respond with ONLY a
 * single JSON object, no markdown, no prose") — parseJsonResponse() below
 * extracts the first {...} block from the response text.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const MODEL = "claude-haiku-4-5" as const;

/** Hard ceiling — no caller can exceed this, regardless of what it requests. */
const MAX_TOKENS_CEILING = 1024;

/** claude-haiku-4-5 pricing, USD per million tokens. */
const PRICE_PER_MTOK_INPUT_USD = 1.0;
const PRICE_PER_MTOK_OUTPUT_USD = 5.0;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

export interface CallClaudeParams {
  /** System prompt. Keep it lean and JSON-only — see module docstring. */
  system: string;
  /** User-turn prompt. */
  prompt: string;
  /** Requested output ceiling; silently clamped to MAX_TOKENS_CEILING. */
  maxTokens?: number;
}

export interface CallClaudeResult {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number;
}

interface RunCostSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

let runTotals: RunCostSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
};

/** Reset the per-run cost accumulator. Call once at the start of a scheduled run. */
export function resetCostTracking(): void {
  runTotals = { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

/** Read the accumulated cost/usage since the last resetCostTracking() call. */
export function getCostSummary(): RunCostSummary & { model: string } {
  return { ...runTotals, model: MODEL };
}

function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICE_PER_MTOK_INPUT_USD +
    (outputTokens / 1_000_000) * PRICE_PER_MTOK_OUTPUT_USD
  );
}

function collectText(content: Anthropic.Messages.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * The single guarded entry point for every Claude call in this repo.
 * No tools, no model override, no unbounded max_tokens.
 */
export async function callClaude(params: CallClaudeParams): Promise<CallClaudeResult> {
  const anthropic = getClient();
  const maxTokens = Math.min(params.maxTokens ?? MAX_TOKENS_CEILING, MAX_TOKENS_CEILING);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: params.system,
    messages: [{ role: "user", content: params.prompt }],
  });

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const estimatedCostUsd = estimateCostUsd(inputTokens, outputTokens);

  runTotals.calls += 1;
  runTotals.inputTokens += inputTokens;
  runTotals.outputTokens += outputTokens;
  runTotals.estimatedCostUsd += estimatedCostUsd;

  console.log(
    `[claude] model=${MODEL} in=${inputTokens} out=${outputTokens} est_cost_usd=$${estimatedCostUsd.toFixed(5)}`
  );

  return {
    text: collectText(response.content),
    model: MODEL,
    usage: { inputTokens, outputTokens },
    estimatedCostUsd,
  };
}

/** Extract the first {...} JSON object from a JSON-only response. Returns null if unparseable. */
export function parseJsonResponse<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
