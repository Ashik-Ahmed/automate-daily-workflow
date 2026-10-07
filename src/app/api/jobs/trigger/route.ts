/**
 * POST /api/jobs/trigger
 * Body: { type: "roster" | "connectivity" }
 * Manually triggers a job.
 */

import { NextRequest, NextResponse } from "next/server";
import { runRosterJob } from "@/lib/jobs/roster-job";
import { runConnectivityJob } from "@/lib/jobs/connectivity-job";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { type } = await req.json() as { type: string };

    if (type === "roster") {
      // Run async — don't await so we return immediately
      runRosterJob("manual").catch((e: unknown) =>
        console.error("[API] Roster job error:", e)
      );
      return NextResponse.json({ ok: true, message: "Roster job triggered. Check Telegram for preview." });
    }

    if (type === "connectivity") {
      runConnectivityJob("manual").catch((e: unknown) =>
        console.error("[API] Connectivity job error:", e)
      );
      return NextResponse.json({ ok: true, message: "Connectivity job triggered. Check Telegram for preview." });
    }

    return NextResponse.json({ ok: false, error: "Unknown job type" }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
