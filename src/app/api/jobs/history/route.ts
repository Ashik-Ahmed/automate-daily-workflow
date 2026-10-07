import { NextResponse } from "next/server";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const runs = await db
      .select()
      .from(jobRuns)
      .orderBy(desc(jobRuns.createdAt))
      .limit(50);
    return NextResponse.json(runs);
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
