/**
 * GET  /api/roster?date=YYYY-MM-DD  — fetch roster for a date
 * POST /api/roster                  — add/update roster entries (JSON array)
 * DELETE /api/roster?id=N           — remove single entry
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rosterEntries } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { format } from "date-fns";
import { normalizeRosterShift } from "@/lib/roster-shifts";
import { isRosterHoliday, saveHolidayDates } from "@/lib/holiday-calendar";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") ?? format(new Date(), "yyyy-MM-dd");
  let rows = await db
    .select()
    .from(rosterEntries)
    .where(eq(rosterEntries.date, date));

  const legacyHolidays = rows.filter(
    (row) => row.shift.toLowerCase() === "holiday" || /^(holiday|durga puja)$/i.test(row.employeeName.trim())
  );
  if (legacyHolidays.length > 0) {
    await saveHolidayDates(
      legacyHolidays.map((row) => ({
        date: row.date,
        name: /^(holiday|durga puja)$/i.test(row.employeeName.trim()) ? row.employeeName : "Holiday",
      }))
    );
    await db.delete(rosterEntries).where(inArray(rosterEntries.id, legacyHolidays.map((row) => row.id)));
    rows = rows.filter((row) => !legacyHolidays.some((holiday) => holiday.id === row.id));
  }
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as unknown;

    // Accept either a single entry or an array
    const items: { employeeName: string; shift?: string; date?: string; notes?: string }[] =
      Array.isArray(body) ? body : [body as { employeeName: string; shift?: string; date?: string; notes?: string }];

    for (const item of items) {
      const date = item.date ?? format(new Date(), "yyyy-MM-dd");
      const holiday = await isRosterHoliday(date);
      if (holiday) {
        return NextResponse.json(
          { ok: false, error: `${date} is ${holiday.name}; roster entries cannot be added for a holiday` },
          { status: 409 }
        );
      }
    }

    const inserted = await db
      .insert(rosterEntries)
      .values(
        items.map((item) => ({
          employeeName: item.employeeName,
          shift: normalizeRosterShift(item.shift ?? "Daytime (Office)"),
          date: item.date ?? format(new Date(), "yyyy-MM-dd"),
          notes: item.notes ?? null,
        }))
      )
      .returning();

    return NextResponse.json({ ok: true, inserted });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  await db.delete(rosterEntries).where(eq(rosterEntries.id, id));
  return NextResponse.json({ ok: true });
}
