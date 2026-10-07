import { eq, like } from "drizzle-orm";
import { isValid, parse, parseISO, format } from "date-fns";
import { db } from "@/db";
import { appConfig } from "@/db/schema";

const HOLIDAY_KEY_PREFIX = "ROSTER_HOLIDAY:";

export interface HolidayDate {
  date: string;
  name: string;
}

export function normalizeHolidayDate(value: unknown): string | undefined {
  if (value instanceof Date && isValid(value)) return format(value, "yyyy-MM-dd");
  if (typeof value === "number") {
    const date = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return isValid(date) ? format(date, "yyyy-MM-dd") : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;

  const text = value.trim();
  const iso = parseISO(text);
  if (isValid(iso)) return format(iso, "yyyy-MM-dd");
  for (const pattern of ["dd.MM.yyyy", "dd/MM/yyyy", "dd MMMM yyyy", "MMMM d, yyyy"]) {
    const parsed = parse(text, pattern, new Date());
    if (isValid(parsed)) return format(parsed, "yyyy-MM-dd");
  }
  return undefined;
}

export async function getHolidayCalendar(): Promise<HolidayDate[]> {
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(like(appConfig.key, `${HOLIDAY_KEY_PREFIX}%`));
  return rows
    .map((row) => ({ date: row.key.slice(HOLIDAY_KEY_PREFIX.length), name: row.value || "Holiday" }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function saveHolidayDates(holidays: HolidayDate[]): Promise<void> {
  for (const holiday of holidays) {
    const date = normalizeHolidayDate(holiday.date);
    if (!date) throw new Error(`Invalid holiday date: ${holiday.date}`);
    const name = holiday.name.trim() || "Holiday";
    await db
      .insert(appConfig)
      .values({ key: `${HOLIDAY_KEY_PREFIX}${date}`, value: name })
      .onConflictDoUpdate({
        target: appConfig.key,
        set: { value: name, updatedAt: new Date() },
      });
  }
}

export async function deleteHolidayDate(value: string): Promise<void> {
  const date = normalizeHolidayDate(value);
  if (!date) throw new Error(`Invalid holiday date: ${value}`);
  await db.delete(appConfig).where(eq(appConfig.key, `${HOLIDAY_KEY_PREFIX}${date}`));
}

export async function isHoliday(date: string): Promise<HolidayDate | undefined> {
  const [row] = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(eq(appConfig.key, `${HOLIDAY_KEY_PREFIX}${date}`))
    .limit(1);
  return row ? { date, name: row.value || "Holiday" } : undefined;
}