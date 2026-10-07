import { NextRequest, NextResponse } from "next/server";
import {
  deleteHolidayDate,
  getHolidayCalendar,
  normalizeHolidayDate,
  saveHolidayDates,
} from "@/lib/holiday-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getHolidayCalendar());
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { date?: unknown; name?: unknown };
    const date = normalizeHolidayDate(body.date);
    if (!date) {
      return NextResponse.json({ error: "Provide a valid holiday date" }, { status: 400 });
    }
    await saveHolidayDates([
      { date, name: typeof body.name === "string" ? body.name : "Holiday" },
    ]);
    return NextResponse.json({ ok: true, date });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const date = req.nextUrl.searchParams.get("date") ?? "";
    await deleteHolidayDate(date);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}