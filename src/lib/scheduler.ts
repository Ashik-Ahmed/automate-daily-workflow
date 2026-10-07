/**
 * Cron scheduler — initialized once when the Next.js server starts.
 * Uses node-cron to schedule daily jobs.
 */

import cron from "node-cron";
import { cfg } from "./config";
import { runRosterJob } from "./jobs/roster-job";
import { runConnectivityJob } from "./jobs/connectivity-job";
import { initConfirmationHandlers, startPolling } from "./telegram";

let _initialized = false;

export async function initScheduler() {
  if (_initialized) return;
  _initialized = true;

  console.log("[Scheduler] Initializing…");

  // Start Telegram bot polling and register handlers
  try {
    initConfirmationHandlers();
    await startPolling();
    console.log("[Scheduler] Telegram bot ready");
  } catch (err: unknown) {
    console.warn(
      "[Scheduler] Telegram not configured:",
      err instanceof Error ? err.message : String(err)
    );
  }

  // Schedule Roster Job
  if (cron.validate(cfg.cron.roster)) {
    cron.schedule(cfg.cron.roster, () => {
      console.log("[Scheduler] Running roster job (scheduled)");
      runRosterJob("scheduled").catch((e: unknown) =>
        console.error("[Scheduler] Roster job failed:", e)
      );
    });
    console.log(`[Scheduler] Roster job scheduled: ${cfg.cron.roster}`);
  }

  // Schedule Connectivity Job
  if (cron.validate(cfg.cron.connectivity)) {
    cron.schedule(cfg.cron.connectivity, () => {
      console.log("[Scheduler] Running connectivity job (scheduled)");
      runConnectivityJob("scheduled").catch((e: unknown) =>
        console.error("[Scheduler] Connectivity job failed:", e)
      );
    });
    console.log(
      `[Scheduler] Connectivity job scheduled: ${cfg.cron.connectivity}`
    );
  }

  console.log("[Scheduler] Ready");
}
