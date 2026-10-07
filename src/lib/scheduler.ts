/**
 * Cron scheduler — initialized once when the Next.js server starts.
 * Uses node-cron to check each minute against the saved job schedule.
 */

import cron from "node-cron";
import { runRosterJob } from "./jobs/roster-job";
import { runConnectivityJob } from "./jobs/connectivity-job";
import { initConfirmationHandlers, startPolling } from "./telegram";
import { getScheduleWindow } from "./schedule-settings";
import { APP_TIME_ZONE, getAppDateParts, getAppDateString, getAppMinuteOfDay } from "./app-time";

const SCHEDULE_CRON = "* * * * *";

interface DailyRun {
  date: string;
  scheduleKey: string;
  minute: number;
  planned: boolean;
  dispatched: boolean;
}

interface SchedulerRuntimeState {
  initialized: boolean;
  initializing: boolean;
  rosterRun: DailyRun | undefined;
  connectivityRun: DailyRun | undefined;
  checkingSchedule: boolean;
  lastSchedulerCheckAt: string | null;
  lastSchedulerError: string | null;
}

type SchedulerGlobal = typeof globalThis & {
  __automateDailyWorkflowScheduler?: SchedulerRuntimeState;
};

const schedulerGlobal = globalThis as SchedulerGlobal;
const schedulerState = (schedulerGlobal.__automateDailyWorkflowScheduler ??= {
  initialized: false,
  initializing: false,
  rosterRun: undefined,
  connectivityRun: undefined,
  checkingSchedule: false,
  lastSchedulerCheckAt: null,
  lastSchedulerError: null,
});

function maybeRunDaily(
  run: DailyRun | undefined,
  now: Date,
  jobName: string,
  windowStart: number,
  windowEnd: number,
  enabledDays: number[],
  runJob: () => void
): DailyRun | undefined {
  const date = getAppDateString(now);
  const scheduleKey = `${windowStart}-${windowEnd}:${[...enabledDays].sort((a, b) => a - b).join(",")}`;
  const nextRun =
    run?.date === date && run.scheduleKey === scheduleKey
      ? run
      : {
          date,
          scheduleKey,
          minute: 0,
          planned: false,
          dispatched: false,
        };

  if (!enabledDays.includes(getAppDateParts(now).weekday)) {
    return nextRun;
  }

  const currentMinute = getAppMinuteOfDay(now);
  if (!nextRun.dispatched && currentMinute > windowEnd) {
    nextRun.dispatched = true;
  }

  if (!nextRun.dispatched && !nextRun.planned) {
    const firstAvailableMinute = Math.max(windowStart, currentMinute);
    if (firstAvailableMinute > windowEnd) {
      nextRun.dispatched = true;
    } else {
      nextRun.minute =
        firstAvailableMinute +
        Math.floor(Math.random() * (windowEnd - firstAvailableMinute + 1));
      nextRun.planned = true;
      console.log(
        `[Scheduler] ${jobName} planned for ${date} at ${String(Math.floor(nextRun.minute / 60)).padStart(2, "0")}:${String(nextRun.minute % 60).padStart(2, "0")} Bangladesh time`
      );
    }
  }

  if (
    !nextRun.dispatched &&
    currentMinute >= nextRun.minute &&
    currentMinute <= windowEnd
  ) {
    nextRun.dispatched = true;
    runJob();
  }

  return nextRun;
}

function getRunStatus(
  run: DailyRun | undefined,
  now: Date,
  scheduleKey: string
) {
  const date = getAppDateString(now);
  return {
    date: run?.date === date && run.scheduleKey === scheduleKey ? date : null,
    plannedTime:
      run?.date === date &&
      run.scheduleKey === scheduleKey &&
      run.planned
        ? `${String(Math.floor(run.minute / 60)).padStart(2, "0")}:${String(run.minute % 60).padStart(2, "0")}`
        : null,
    dispatched:
      run?.date === date &&
      run.scheduleKey === scheduleKey &&
      run.dispatched,
  };
}

export function getSchedulerStatus(schedule: {
  start: string;
  end: string;
  days: number[];
}) {
  const now = new Date();
  const minute = (time: string) =>
    Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const scheduleKey = `${minute(schedule.start)}-${minute(schedule.end)}:${[...schedule.days].sort((a, b) => a - b).join(",")}`;
  return {
    initialized: schedulerState.initialized,
    initializing: schedulerState.initializing,
    lastCheckedAt: schedulerState.lastSchedulerCheckAt,
    lastError: schedulerState.lastSchedulerError,
    roster: getRunStatus(schedulerState.rosterRun, now, scheduleKey),
    connectivity: getRunStatus(schedulerState.connectivityRun, now, scheduleKey),
  };
}

export async function initScheduler() {
  if (schedulerState.initialized || schedulerState.initializing) return;
  schedulerState.initializing = true;

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

  cron.schedule(SCHEDULE_CRON, () => {
    if (schedulerState.checkingSchedule) return;
    schedulerState.checkingSchedule = true;
    void (async () => {
      const now = new Date();
      schedulerState.lastSchedulerCheckAt = now.toISOString();
      const window = await getScheduleWindow();
      const [startHour, startMinute] = window.start.split(":").map(Number);
      const [endHour, endMinute] = window.end.split(":").map(Number);
      const windowStart = startHour! * 60 + startMinute!;
      const windowEnd = endHour! * 60 + endMinute!;

      schedulerState.rosterRun = maybeRunDaily(
        schedulerState.rosterRun,
        now,
        "Roster",
        windowStart,
        windowEnd,
        window.days,
        () => {
          console.log("[Scheduler] Running roster job (scheduled)");
          runRosterJob("scheduled").catch((e: unknown) =>
            console.error("[Scheduler] Roster job failed:", e)
          );
        }
      );
      schedulerState.connectivityRun = maybeRunDaily(
        schedulerState.connectivityRun,
        now,
        "Connectivity",
        windowStart,
        windowEnd,
        window.days,
        () => {
          console.log("[Scheduler] Running connectivity job (scheduled)");
          runConnectivityJob("scheduled").catch((e: unknown) =>
            console.error("[Scheduler] Connectivity job failed:", e)
          );
        }
      );
      schedulerState.lastSchedulerError = null;
    })()
      .catch((error: unknown) => {
        schedulerState.lastSchedulerError =
          error instanceof Error ? error.message : String(error);
        console.error("[Scheduler] Could not load schedule settings:", error);
      })
      .finally(() => {
        schedulerState.checkingSchedule = false;
      });
  }, { timezone: APP_TIME_ZONE });
  schedulerState.initialized = true;
  schedulerState.initializing = false;
  console.log("[Scheduler] Checking each minute against saved days and time window");

  console.log("[Scheduler] Ready");
}
