/**
 * Lead scoring (0–100). Weighs four factors:
 *   - filing type     (S-1 withdrawal > Reg A+ > 8-K material event)
 *   - sector fit      (from SIC -> sector mapping)
 *   - state proximity (Texas favored, then Sun Belt / TX neighbors)
 *   - offering size   (sweet spot inside the lower-middle-market band)
 *
 * Leads scoring >= MIN_LEAD_SCORE are persisted; >= 65 are high priority.
 */
import { HIGH_PRIORITY_SCORE } from "./config.js";
import { sicToSector } from "./edgar/sectors.js";
import type { LeadSignal, MonitorKind } from "./edgar/types.js";

// Filing-type contribution (max 35).
const FORM_SCORE: Record<MonitorKind, number> = {
  s1_withdrawal: 35,
  reg_a: 25,
  material_event: 18,
};

// Texas is the bullseye; Sun Belt and TX neighbors rank next.
const SUN_BELT = new Set([
  "FL",
  "GA",
  "AZ",
  "NC",
  "SC",
  "TN",
  "NV",
  "AL",
  "MS",
]);
const TX_NEIGHBORS = new Set(["OK", "LA", "NM", "AR"]);

function stateScore(state: string): number {
  const s = (state || "").toUpperCase();
  if (s === "TX") return 20;
  if (SUN_BELT.has(s) || TX_NEIGHBORS.has(s)) return 15;
  if (s.length === 2) return 6; // other US state
  return 2; // unknown / foreign
}

/** Offering-size contribution (max 20); sweet spot is the $5M–$75M band. */
function sizeScore(usd: number | null): number {
  if (usd === null) return 8; // unknown — neutral-ish
  if (usd < 1_000_000) return 4;
  if (usd < 5_000_000) return 10;
  if (usd <= 75_000_000) return 20; // lower-middle-market sweet spot
  if (usd <= 250_000_000) return 14;
  return 8; // too big for the focus segment
}

export interface ScoreBreakdown {
  filing_type: number;
  sector_fit: number;
  state_proximity: number;
  offering_size: number;
  total: number;
}

export interface ScoredLead {
  signal: LeadSignal;
  score: number;
  sector: string;
  isHighPriority: boolean;
  breakdown: ScoreBreakdown;
}

export function scoreLead(signal: LeadSignal): ScoredLead {
  const sectorInfo = sicToSector(signal.sics[0]);

  const form = FORM_SCORE[signal.monitor];
  const sector = Math.round(sectorInfo.fit * 25); // max 25
  const state = stateScore(signal.bizState);
  const size = sizeScore(signal.offeringSizeUsd);

  const score = Math.max(0, Math.min(100, Math.round(form + sector + state + size)));

  return {
    signal,
    score,
    sector: sectorInfo.sector,
    isHighPriority: score >= HIGH_PRIORITY_SCORE,
    breakdown: {
      filing_type: form,
      sector_fit: sector,
      state_proximity: state,
      offering_size: size,
      total: score,
    },
  };
}
