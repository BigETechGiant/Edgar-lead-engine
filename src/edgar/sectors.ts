/**
 * SIC -> sector mapping and target-sector logic for the lead engine.
 *
 * Target sectors reflect the lower-middle-market segments Solventis focuses on.
 * SIC ranges are coarse but adequate for sector fit scoring and for filtering
 * the high-volume 8-K stream down to relevant companies.
 */

export interface SectorInfo {
  sector: string;
  /** Sector-fit weight 0..1 used by scoring. */
  fit: number;
}

interface SicRange {
  lo: number;
  hi: number;
  sector: string;
  fit: number;
}

// Ordered list of SIC ranges. First match wins.
const RANGES: SicRange[] = [
  { lo: 1, hi: 999, sector: "Agriculture", fit: 0.4 },
  { lo: 1000, hi: 1499, sector: "Mining & Energy", fit: 0.6 },
  { lo: 1500, hi: 1799, sector: "Construction", fit: 0.7 },
  { lo: 2000, hi: 3999, sector: "Manufacturing", fit: 0.9 },
  { lo: 4000, hi: 4799, sector: "Transportation & Logistics", fit: 0.8 },
  { lo: 4800, hi: 4899, sector: "Communications", fit: 0.7 },
  { lo: 4900, hi: 4999, sector: "Utilities", fit: 0.5 },
  { lo: 5000, hi: 5199, sector: "Wholesale Distribution", fit: 0.85 },
  { lo: 5200, hi: 5999, sector: "Retail & Consumer", fit: 0.7 },
  { lo: 6000, hi: 6199, sector: "Banking", fit: 0.5 },
  { lo: 6200, hi: 6299, sector: "Financial Services", fit: 0.6 },
  { lo: 6300, hi: 6499, sector: "Insurance", fit: 0.6 },
  { lo: 6500, hi: 6799, sector: "Real Estate", fit: 0.6 },
  { lo: 7000, hi: 7299, sector: "Business & Consumer Services", fit: 0.85 },
  { lo: 7300, hi: 7399, sector: "Business Services", fit: 0.9 },
  { lo: 7370, hi: 7379, sector: "Technology / IT Services", fit: 0.95 },
  { lo: 7400, hi: 7999, sector: "Services", fit: 0.8 },
  { lo: 8000, hi: 8099, sector: "Healthcare Services", fit: 0.95 },
  { lo: 8100, hi: 8999, sector: "Professional Services", fit: 0.85 },
];

const DEFAULT: SectorInfo = { sector: "Other", fit: 0.4 };

export function sicToSector(sic: string | undefined | null): SectorInfo {
  const n = Number.parseInt((sic ?? "").replace(/\D/g, ""), 10);
  if (!Number.isFinite(n)) return DEFAULT;
  // Prefer the most specific (narrowest) matching range.
  let best: SicRange | null = null;
  for (const r of RANGES) {
    if (n >= r.lo && n <= r.hi) {
      if (!best || r.hi - r.lo < best.hi - best.lo) best = r;
    }
  }
  return best ? { sector: best.sector, fit: best.fit } : DEFAULT;
}

/** A SIC is "in target" if its sector fit meets this bar. */
export function isTargetSic(sic: string): boolean {
  return sicToSector(sic).fit >= 0.7;
}

/** True if any of the provided SICs is a target sector. */
export function anyTargetSic(sics: string[]): boolean {
  return sics.some(isTargetSic);
}
