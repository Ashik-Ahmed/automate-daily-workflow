import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { appConfig } from "@/db/schema";

const SCHEDULE_START_KEY = "JOB_SCHEDULE_START";
const SCHEDULE_END_KEY = "JOB_SCHEDULE_END";
const SCHEDULE_DAYS_KEY = "JOB_SCHEDULE_DAYS";

export const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

export const DEFAULT_SCHEDULE_WINDOW = {
  start: "08:30",
  end: "08:50",
};

export interface ScheduleWindow {
  start: string;
  end: string;
  days: number[];
}

export function isValidScheduleWindow(value: unknown): value is ScheduleWindow {
  if (!value || typeof value !== "object") return false;
  const { start, end, days } = value as Record<string, unknown>;
  const isTime = (time: unknown): time is string =>
    typeof time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
  return (
    isTime(start) &&
    isTime(end) &&
    start <= end &&
    Array.isArray(days) &&
    days.length > 0 &&
    days.every(
      (day) =>
        typeof day === "number" &&
        Number.isInteger(day) &&
        day >= 0 &&
        day <= 6
    ) &&
    new Set(days).size === days.length
  );
}

export async function getScheduleWindow(): Promise<ScheduleWindow> {
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(
      inArray(appConfig.key, [
        SCHEDULE_START_KEY,
        SCHEDULE_END_KEY,
        SCHEDULE_DAYS_KEY,
      ])
    );
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  const window = {
    start: values.get(SCHEDULE_START_KEY) ?? DEFAULT_SCHEDULE_WINDOW.start,
    end: values.get(SCHEDULE_END_KEY) ?? DEFAULT_SCHEDULE_WINDOW.end,
    days: values.has(SCHEDULE_DAYS_KEY)
      ? values
          .get(SCHEDULE_DAYS_KEY)!
          .split(",")
          .map((day) => Number(day))
      : [0, 1, 2, 3, 4],
  };

  if (!isValidScheduleWindow(window)) {
    throw new Error("The saved automatic job schedule is invalid");
  }
  return window;
}

export async function saveScheduleWindow(window: ScheduleWindow): Promise<void> {
  if (!isValidScheduleWindow(window)) {
    throw new Error("Schedule times must be valid and the end must not precede the start");
  }

  await db.transaction(async (tx) => {
    for (const [key, value] of [
      [SCHEDULE_START_KEY, window.start],
      [SCHEDULE_END_KEY, window.end],
      [SCHEDULE_DAYS_KEY, window.days.join(",")],
    ]) {
      await tx
        .insert(appConfig)
        .values({ key, value })
        .onConflictDoUpdate({
          target: appConfig.key,
          set: { value, updatedAt: new Date() },
        });
    }
  });
}
