import { NextResponse } from "next/server";
import { db } from "@/db";
import { connectivityResults } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(connectivityResults)
    .orderBy(desc(connectivityResults.createdAt))
    .limit(30);
  return NextResponse.json(rows);
}
