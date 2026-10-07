import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { appConfig } from "@/db/schema";
import { cfg } from "./config";

const recipientKeys = [
  "ROSTER_EMAIL_TO",
  "ROSTER_EMAIL_CC",
  "CONNECTIVITY_EMAIL_TO",
  "CONNECTIVITY_EMAIL_CC",
] as const;

export interface EmailRecipients {
  rosterTo: string[];
  rosterCc: string[];
  connectivityTo: string[];
  connectivityCc: string[];
}

function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
}

export async function getEmailRecipients(): Promise<EmailRecipients> {
  const rows = await db
    .select({ key: appConfig.key, value: appConfig.value })
    .from(appConfig)
    .where(inArray(appConfig.key, [...recipientKeys]));
  const saved = new Map(rows.map(({ key, value }) => [key, value ?? ""]));
  const get = (key: (typeof recipientKeys)[number], fallback: string[]) =>
    splitAddresses(saved.has(key) ? saved.get(key)! : fallback.join(","));

  return {
    rosterTo: get("ROSTER_EMAIL_TO", cfg.email.rosterTo),
    rosterCc: get("ROSTER_EMAIL_CC", cfg.email.rosterCc),
    connectivityTo: get("CONNECTIVITY_EMAIL_TO", cfg.email.connectivityTo),
    connectivityCc: get("CONNECTIVITY_EMAIL_CC", cfg.email.connectivityCc),
  };
}