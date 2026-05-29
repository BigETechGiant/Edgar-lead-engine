/**
 * edgar-lead-engine entrypoint.
 *
 * Long-running web service for Railway:
 *   - POST /trigger  (x-api-key protected) -> kicks off a full run, returns summary
 *   - GET  /health   -> 200
 *   - daily cron     -> scrape at 06:00 and digest at 07:00 America/Chicago
 *
 * On boot we ONLY start the server and register the cron — no auto-scrape.
 */
import express, { type Request, type Response } from "express";
import cron from "node-cron";
import { config } from "./config.js";
import { runFullRun } from "./run.js";
import { sendDigest } from "./digest.js";

const app = express();
app.use(express.json());

// Prevent overlapping runs (cron + manual trigger).
let runInProgress = false;

async function executeRun(trigger: string) {
  if (runInProgress) {
    console.warn(`[run] ${trigger}: a run is already in progress; skipping.`);
    return { skipped: true as const };
  }
  runInProgress = true;
  try {
    console.log(`[run] starting (${trigger})`);
    const summary = await runFullRun();
    console.log(
      `[run] done (${trigger}): checked=${summary.filingsChecked} found=${summary.leadsFound} new=${summary.leadsNew} dup=${summary.leadsDuplicate}`
    );
    return { skipped: false as const, summary };
  } finally {
    runInProgress = false;
  }
}

// --- Routes ------------------------------------------------------------------

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

app.post("/trigger", async (req: Request, res: Response) => {
  const key = req.header("x-api-key");
  if (key !== config.edgarEngineKey) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const result = await executeRun("POST /trigger");
    if (result.skipped) {
      return res.status(202).json({ status: "run already in progress" });
    }
    const s = result.summary;
    return res.status(200).json({
      status: "ok",
      filingsChecked: s.filingsChecked,
      leadsFound: s.leadsFound,
      leadsNew: s.leadsNew,
      leadsDuplicate: s.leadsDuplicate,
      monitors: s.monitors,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    });
  } catch (err) {
    console.error("[trigger] run failed:", err);
    return res.status(500).json({ error: (err as Error).message });
  }
});

// --- Cron --------------------------------------------------------------------

function registerCron() {
  const tz = "America/Chicago";

  // Daily scrape at 06:00 CT.
  cron.schedule(
    "0 6 * * *",
    () => {
      executeRun("cron 06:00 scrape").catch((e) =>
        console.error("[cron] scrape failed:", e)
      );
    },
    { timezone: tz }
  );

  // Daily digest at 07:00 CT.
  cron.schedule(
    "0 7 * * *",
    () => {
      sendDigest()
        .then((r) =>
          console.log(
            `[cron] digest: sent=${r.sent} high=${r.highCount} medium=${r.mediumCount}${r.reason ? ` (${r.reason})` : ""}`
          )
        )
        .catch((e) => console.error("[cron] digest failed:", e));
    },
    { timezone: tz }
  );

  console.log(`[cron] registered: scrape 06:00, digest 07:00 (${tz})`);
}

// --- Boot --------------------------------------------------------------------

app.listen(config.port, () => {
  console.log(`[boot] edgar-lead-engine listening on port ${config.port}`);
  console.log(
    `[boot] min_lead_score=${config.minLeadScore} lookback_days=${config.lookbackDays} enrichment=${config.enrichmentEnabled} digest=${config.digestEnabled}`
  );
  registerCron();
});
