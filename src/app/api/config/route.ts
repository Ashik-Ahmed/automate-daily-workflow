/**
 * GET  /api/config  — return non-sensitive config/status
 * POST /api/config  — update DB-stored config values
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cfg } from "@/lib/config";
import { verifySmtp } from "@/lib/mailer";
import { getEmailRecipients } from "@/lib/email-recipients";

export const dynamic = "force-dynamic";

export async function GET() {
  const smtpOk = cfg.smtp.user ? await verifySmtp() : false;
  const telegramOk = !!cfg.telegram.token && !!cfg.telegram.chatId;
  const asaOk = !!cfg.asa.host;
  const emailRecipients = await getEmailRecipients();

  return NextResponse.json({
    smtp: {
      host: cfg.smtp.host,
      user: cfg.smtp.user ? cfg.smtp.user.replace(/(.{2}).*(@.*)/, "$1***$2") : "(not set)",
      ok: smtpOk,
    },
    telegram: {
      chatId: cfg.telegram.chatId ? cfg.telegram.chatId : "(not set)",
      ok: telegramOk,
    },
    asa: {
      host: cfg.asa.host || "(not set)",
      ok: asaOk,
    },
    schedule: {
      roster: cfg.cron.roster,
      connectivity: cfg.cron.connectivity,
    },
    email: emailRecipients,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as { email?: Record<string, unknown> };
  const fields = [
    ["ROSTER_EMAIL_TO", body.email?.rosterTo, true],
    ["ROSTER_EMAIL_CC", body.email?.rosterCc, false],
    ["CONNECTIVITY_EMAIL_TO", body.email?.connectivityTo, true],
    ["CONNECTIVITY_EMAIL_CC", body.email?.connectivityCc, false],
  ] as const;

  const values: Array<{ key: string; value: string }> = [];
  for (const [key, input, required] of fields) {
    if (typeof input !== "string") {
      return NextResponse.json({ error: `Missing recipient field: ${key}` }, { status: 400 });
    }
    const addresses = input
      .split(",")
      .map((address) => address.trim())
      .filter(Boolean);
    if ((required && addresses.length === 0) || addresses.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
      return NextResponse.json({ error: `Check the email addresses in ${key}` }, { status: 400 });
    }
    values.push({ key, value: addresses.join(",") });
  }

  for (const { key, value } of values) {
    await db
      .insert(appConfig)
      .values({ key, value })
      .onConflictDoUpdate({ target: appConfig.key, set: { value, updatedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
