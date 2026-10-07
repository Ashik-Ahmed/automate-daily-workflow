import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { stakeholders } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(stakeholders);
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { name: string; peerIp: string; description?: string };
  const [row] = await db
    .insert(stakeholders)
    .values({
      name: body.name,
      peerIp: body.peerIp,
      description: body.description ?? null,
    })
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(req: NextRequest) {
  const id = Number(req.nextUrl.searchParams.get("id"));
  await db.delete(stakeholders).where(eq(stakeholders.id, id));
  return NextResponse.json({ ok: true });
}
