/**
 * SEC EDGAR HTTP client.
 *
 * - Sends the descriptive User-Agent (EDGAR_USER_AGENT) on EVERY request, as
 *   the SEC requires; requests without it get 403.
 * - Global rate limit of <= 10 requests/second across all monitors via a
 *   shared async gate (we use a ~120ms minimum spacing for safety margin).
 * - Two endpoints:
 *     full-text search: https://efts.sec.gov/LATEST/search-index
 *     company profile : https://data.sec.gov/submissions/CIK##########.json
 */
import { config } from "../config.js";

const FTS_URL = "https://efts.sec.gov/LATEST/search-index";
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";

/** ~8.3 req/s — comfortably under the 10 req/s ceiling. */
const MIN_INTERVAL_MS = 120;
let lastRequestAt = 0;
let chain: Promise<void> = Promise.resolve();

/** Serialize requests and space them out to respect the rate limit. */
function rateLimit(): Promise<void> {
  const wait = chain.then(async () => {
    const now = Date.now();
    const gap = now - lastRequestAt;
    if (gap < MIN_INTERVAL_MS) {
      await sleep(MIN_INTERVAL_MS - gap);
    }
    lastRequestAt = Date.now();
  });
  // Keep the chain from rejecting permanently.
  chain = wait.catch(() => undefined);
  return wait;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function edgarFetch(url: string): Promise<Response> {
  await rateLimit();
  const res = await fetch(url, {
    headers: {
      "User-Agent": config.edgarUserAgent,
      Accept: "application/json",
      "Accept-Encoding": "gzip, deflate",
    },
  });
  return res;
}

/** One filing hit from the full-text search index. */
export interface FtsHit {
  accessionNumber: string; // e.g. 0001234567-24-000123
  cik: string; // zero-padded 10-digit, best effort
  form: string;
  fileDate: string; // YYYY-MM-DD
  periodOfReport: string; // YYYY-MM-DD, may be empty
  fileDescription: string; // filing description, may be empty
  displayName: string; // "COMPANY NAME (CIK 0001234567)"
  bizStates: string[];
  sics: string[];
  primaryDoc: string; // document file name within the accession
}

interface FtsRawSource {
  ciks?: string[];
  display_names?: string[];
  file_date?: string;
  period_ending?: string;
  file_description?: string;
  form?: string;
  root_forms?: string[];
  file_type?: string;
  biz_states?: string[];
  sics?: string[];
}
interface FtsRawHit {
  _id?: string;
  _source?: FtsRawSource;
}
interface FtsResponse {
  hits?: {
    total?: { value?: number };
    hits?: FtsRawHit[];
  };
}

function pad10(cik: string): string {
  const digits = cik.replace(/\D/g, "");
  return digits.padStart(10, "0");
}

function parseHit(raw: FtsRawHit): FtsHit | null {
  const src = raw._source;
  if (!src) return null;
  // _id looks like "0001234567-24-000123:primary_doc.html"
  const id = raw._id ?? "";
  const [adshFromId, primaryDoc = ""] = id.split(":");
  const accessionNumber = adshFromId ?? "";
  if (!accessionNumber) return null;

  const cikRaw = src.ciks?.[0] ?? "";
  const form = src.file_type ?? src.form ?? src.root_forms?.[0] ?? "";

  return {
    accessionNumber,
    cik: pad10(cikRaw),
    form,
    fileDate: src.file_date ?? "",
    periodOfReport: src.period_ending ?? "",
    fileDescription: src.file_description ?? "",
    displayName: src.display_names?.[0] ?? "",
    bizStates: src.biz_states ?? [],
    sics: src.sics ?? [],
    primaryDoc,
  };
}

/**
 * Full-text search filtered by form type(s) and a date window.
 * Paginates through results (EDGAR returns 10 per page) up to maxPages.
 */
export async function fullTextSearch(opts: {
  forms: string; // comma-separated, e.g. "1-A,1-K"
  startdt: string; // YYYY-MM-DD
  enddt: string; // YYYY-MM-DD
  query?: string; // optional q term
  maxPages?: number;
}): Promise<FtsHit[]> {
  const { forms, startdt, enddt, query = "", maxPages = 10 } = opts;
  const out: FtsHit[] = [];

  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({
      forms,
      startdt,
      enddt,
      from: String(page * 10),
    });
    if (query) params.set("q", query);

    const res = await edgarFetch(`${FTS_URL}?${params.toString()}`);
    if (!res.ok) {
      // 400 on out-of-range `from` is the natural end of pagination.
      if (res.status === 400 && page > 0) break;
      throw new Error(
        `EDGAR FTS ${forms} failed: HTTP ${res.status} ${await res.text()}`
      );
    }
    const json = (await res.json()) as FtsResponse;
    const hits = json.hits?.hits ?? [];
    if (hits.length === 0) break;

    for (const h of hits) {
      const parsed = parseHit(h);
      if (parsed) out.push(parsed);
    }

    const total = json.hits?.total?.value ?? 0;
    if ((page + 1) * 10 >= total) break;
  }

  return out;
}

/** Company profile fields we care about from the submissions endpoint. */
export interface CompanyProfile {
  cik: string;
  name: string;
  sic: string;
  sicDescription: string;
  stateOfIncorporation: string;
  businessState: string; // from business address
  businessCity: string; // from business address
  phone: string;
  website: string;
}

interface SubmissionsAddress {
  stateOrCountry?: string;
  city?: string;
}
interface SubmissionsResponse {
  cik?: string;
  name?: string;
  sic?: string;
  sicDescription?: string;
  stateOfIncorporation?: string;
  phone?: string;
  website?: string;
  addresses?: {
    business?: SubmissionsAddress;
    mailing?: SubmissionsAddress;
  };
}

export async function getCompanyProfile(
  cik: string
): Promise<CompanyProfile | null> {
  const padded = pad10(cik);
  if (!padded || padded === "0000000000") return null;

  const res = await edgarFetch(`${SUBMISSIONS_BASE}/CIK${padded}.json`);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(
      `EDGAR submissions CIK${padded} failed: HTTP ${res.status}`
    );
  }
  const j = (await res.json()) as SubmissionsResponse;
  return {
    cik: padded,
    name: j.name ?? "",
    sic: j.sic ?? "",
    sicDescription: j.sicDescription ?? "",
    stateOfIncorporation: j.stateOfIncorporation ?? "",
    businessState:
      j.addresses?.business?.stateOrCountry ??
      j.addresses?.mailing?.stateOrCountry ??
      "",
    businessCity:
      j.addresses?.business?.city ?? j.addresses?.mailing?.city ?? "",
    phone: j.phone ?? "",
    website: j.website ?? "",
  };
}

/**
 * Direct link to the filing index page for an accession number, e.g.
 * https://www.sec.gov/Archives/edgar/data/1234567/000123456724000123/0001234567-24-000123-index.htm
 */
export function edgarFilingUrl(cik: string, accessionNumber: string): string {
  const cikNoPad = pad10(cik).replace(/^0+/, "");
  const noDashes = accessionNumber.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${cikNoPad}/${noDashes}/${accessionNumber}-index.htm`;
}

export { pad10 };
