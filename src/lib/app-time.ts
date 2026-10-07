export const APP_TIME_ZONE = "Asia/Dhaka";

const WEEKDAY_INDEX: Record<string, number> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

export function getAppDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: WEEKDAY_INDEX[values.weekday!],
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

export function getAppDateString(date = new Date()): string {
  const { year, month, day } = getAppDateParts(date);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function getAppMinuteOfDay(date = new Date()): number {
  const { hour, minute } = getAppDateParts(date);
  return hour * 60 + minute;
}

export function formatAppDateTime(
  value: Date | string,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    ...options,
    timeZone: APP_TIME_ZONE,
  }).format(value instanceof Date ? value : new Date(value));
}

export function formatJobStartedAt(createdAt: string, updatedAt: string): string {
  const started = new Date(createdAt);
  const updated = new Date(updatedAt);
  const elapsed = updated.getTime() - started.getTime();

  // Repair legacy rows where PostgreSQL wrote created_at in UTC but app-written
  // updated_at was stored in Bangladesh local time (the database columns lack TZ).
  if (Number.isFinite(elapsed) && elapsed > 60 * 60 * 1000) {
    started.setTime(started.getTime() + 6 * 60 * 60 * 1000);
  }

  return formatAppDateTime(started);
}

export function formatAppDateLabel(
  date: string,
  options: Intl.DateTimeFormatOptions
): string {
  return formatAppDateTime(new Date(`${date}T12:00:00Z`), options);
}
