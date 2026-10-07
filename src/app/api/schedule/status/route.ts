import { NextResponse } from "next/server";
import { getScheduleWindow } from "@/lib/schedule-settings";
import { getSchedulerStatus } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const now = new Date();
    const schedule = await getScheduleWindow();
    return NextResponse.json({
      serverTime: now.toISOString(),
      serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      schedule,
      scheduler: {
        ...getSchedulerStatus(schedule),
        selectedToday: schedule.days.includes(now.getDay()),
        serverMinuteOfDay: now.getHours() * 60 + now.getMinutes(),
        windowStartMinute: Number(schedule.start.slice(0, 2)) * 60 + Number(schedule.start.slice(3)),
        windowEndMinute: Number(schedule.end.slice(0, 2)) * 60 + Number(schedule.end.slice(3)),
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
