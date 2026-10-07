/**
 * Daily Roster Email Job
 * 1. Pull today's roster from DB
 * 2. Apply any text adjustments mentioned by manager
 * 3. Send Telegram preview + confirmation
 * 4. Send email to management
 */

import { asc, eq, and, sql } from "drizzle-orm";
import { format, parseISO } from "date-fns";
import { db } from "@/db";
import { rosterEntries, jobRuns } from "@/db/schema";
import {
  escapeTelegramHtml,
  markJobRunnerActive,
  markJobRunnerInactive,
  registerJobResumer,
  sendConfirmationRequest,
  sendNotification,
} from "@/lib/telegram";
import { sendEmail } from "@/lib/mailer";
import { getEmailRecipients } from "@/lib/email-recipients";
import { isHoliday } from "@/lib/holiday-calendar";
import { formatAppDateLabel, getAppDateString } from "@/lib/app-time";
import {
  claimJobDelivery,
  createJobRetryBudget,
  retryImmediatelyUntilSuccessful,
} from "@/lib/job-retry";

export interface RosterEntry {
  employeeName: string;
  shift: string;
  notes?: string | null;
}

export function applyAdjustments(
  entries: RosterEntry[],
  adjustment: string
): RosterEntry[] {
  const commands = adjustment
    .split(/[;\r\n]+/)
    .map((command) => command.trim().replace(/\.$/, ""))
    .filter(Boolean);
  let updatedEntries = entries;

  for (const command of commands) {
    const replaceMatch = command.match(/^replace\s+(.+?)\s+with\s+(.+)$/i);
    if (replaceMatch) {
      const from = replaceMatch[1]?.trim() ?? "";
      let to = replaceMatch[2]?.trim() ?? "";
      let shiftScope: string | undefined;
      const scopeMatch = to.match(/^(.*?)\s+(?:in|for)\s+(?:the\s+)?(.+?)\s+shift$/i);
      if (scopeMatch) {
        to = scopeMatch[1]?.trim() ?? "";
        shiftScope = scopeMatch[2]?.trim();
      }
      const normalizedScope = shiftScope?.toLowerCase().replace(/[^a-z0-9]/g, "");
      const matches = updatedEntries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) =>
          entry.employeeName.toLowerCase() === from.toLowerCase() &&
          (!normalizedScope || entry.shift.toLowerCase().replace(/[^a-z0-9]/g, "").includes(normalizedScope))
        );
      if (!from || !to || matches.length === 0) {
        throw new Error(`Could not find "${from}" in the requested shift for: ${command}`);
      }
      const matchedIndices = new Set(matches.map(({ index }) => index));
      updatedEntries = updatedEntries.map((entry, index) =>
        matchedIndices.has(index)
          ? { ...entry, employeeName: to }
          : entry
      );
      continue;
    }

    const removeMatch = command.match(/^remove\s+(.+)$/i);
    if (removeMatch) {
      const name = removeMatch[1]?.trim() ?? "";
      const remaining = updatedEntries.filter(
        (entry) => entry.employeeName.toLowerCase() !== name.toLowerCase()
      );
      if (remaining.length === updatedEntries.length) {
        throw new Error(`Could not find roster employee "${name}" to remove`);
      }
      updatedEntries = remaining;
      continue;
    }

    const swapMatch = command.match(/^swap\s+(.+?)\s+and\s+(.+?)(?:\s+shifts?)?$/i);
    if (swapMatch) {
      const firstName = swapMatch[1]?.trim() ?? "";
      const secondName = swapMatch[2]?.trim() ?? "";
      const firstIndices = updatedEntries.flatMap((entry, index) =>
        entry.employeeName.toLowerCase() === firstName.toLowerCase() ? [index] : []
      );
      const secondIndices = updatedEntries.flatMap((entry, index) =>
        entry.employeeName.toLowerCase() === secondName.toLowerCase() ? [index] : []
      );
      if (!firstName || !secondName || firstIndices.length !== 1 || secondIndices.length !== 1) {
        throw new Error(`Swap requires each employee name to match exactly one roster entry: ${command}`);
      }
      const firstIndex = firstIndices[0]!;
      const secondIndex = secondIndices[0]!;
      const firstShift = updatedEntries[firstIndex]!.shift;
      const secondShift = updatedEntries[secondIndex]!.shift;
      updatedEntries = updatedEntries.map((entry, index) =>
        index === firstIndex
          ? { ...entry, shift: secondShift }
          : index === secondIndex
          ? { ...entry, shift: firstShift }
          : entry
      );
      continue;
    }

    const addMatch = command.match(/^add\s+(.+?)\s+to\s+(.+?)\s+shift$/i);
    if (addMatch) {
      const name = addMatch[1]?.trim() ?? "";
      const shift = addMatch[2]?.trim() ?? "";
      if (!name || !shift) throw new Error(`Could not understand roster addition: ${command}`);
      updatedEntries = [...updatedEntries, { employeeName: name, shift, notes: "Added manually" }];
      continue;
    }

    if (commands.length === 1) {
      return updatedEntries.map((entry) => ({
        ...entry,
        notes: entry.notes ? `${entry.notes}; ${command}` : command,
      }));
    }
    throw new Error(`Could not understand roster change: ${command}. Separate valid commands with semicolons.`);
  }

  return updatedEntries;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function rosterGroup(shift: string): "office" | "homeOffice" | "evening" | "morning" {
  const normalized = shift.toLowerCase();
  if (normalized.includes("holiday") || normalized.includes("puja")) return "morning";
  if (normalized.includes("morning")) return "morning";
  if (normalized.includes("evening") || normalized.includes("night")) return "evening";
  if (normalized.includes("home")) return "homeOffice";
  return "office";
}

function buildRosterEmailHtml(entries: RosterEntry[], date: string): string {
  const dateDisplay = format(parseISO(date), "EEEE, MMMM d, yyyy");
  const office = entries.filter((entry) => rosterGroup(entry.shift) === "office");
  const homeOffice = entries.filter((entry) => rosterGroup(entry.shift) === "homeOffice");
  const daytime = [...office, ...homeOffice];
  const evening = entries.filter((entry) => rosterGroup(entry.shift) === "evening");
  const morning = entries.filter((entry) => rosterGroup(entry.shift) === "morning");
  const holiday = entries.find((entry) => /holiday|puja/i.test(entry.shift));
  const daytimeCount = Math.max(1, office.length + homeOffice.length);
  const eveningCount = Math.max(1, evening.length);
  const morningCount = Math.max(1, morning.length);

  const assignmentCells = (group: RosterEntry[], emptyCount = 1) =>
    (group.length > 0 ? group : Array.from({ length: emptyCount }, () => null))
      .map((entry) => `<td style="border:1px solid #222;padding:2px 6px;text-align:center;white-space:nowrap">${entry ? escapeHtml(entry.employeeName) : "&nbsp;"}</td>`)
      .join("");

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#111;font-size:16px">
  <p>Dear Sir,</p>
  <p>Below is the list of Technology team members from whom the responsible member(s) will provide regular system updates and porting information. Starting from 11:00 AM, in Every three (3) hours, the system status and porting count would be updated by the assigned Team members.</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;font-family:Arial,sans-serif;font-size:14px">
    <thead>
      <tr style="font-weight:bold;text-align:center">
        <th style="background:#fff200;border:1px solid #222;padding:2px 8px">Date</th>
        <th colspan="${daytimeCount}" style="background:#8ea8cf;border:1px solid #222;padding:2px 8px">Daytime (Office/ Home-Office)</th>
        <th colspan="${eveningCount}" style="background:#4472c4;border:1px solid #222;padding:2px 8px">Evening (Home)</th>
        <th colspan="${morningCount}" style="background:#ed7d31;border:1px solid #222;padding:2px 8px">Morning Report</th>
      </tr>
    </thead>
    <tbody>
      <tr style="text-align:center">
        <td style="border:1px solid #222;padding:2px 8px;white-space:nowrap">${dateDisplay}</td>
        ${holiday
          ? `<td colspan="${daytimeCount + eveningCount + morningCount}" style="background:#000;color:#fff;border:1px solid #222;padding:2px 8px">${escapeHtml(holiday.employeeName)}</td>`
            : `${assignmentCells(daytime, daytimeCount)}${assignmentCells(evening, eveningCount)}${assignmentCells(morning, morningCount)}`}
      </tr>
    </tbody>
  </table>
</body>
</html>`;
}

function buildTelegramPreview(entries: RosterEntry[], date: string): string {
  const dateDisplay = formatAppDateLabel(date, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    weekday: "long",
  });
  const shifts = [...new Set(entries.map((e) => e.shift))].sort();
  let text = `📋 <b>ROSTER EMAIL PREVIEW</b>\n📅 ${dateDisplay}\n\n`;

  for (const shift of shifts) {
    const shiftEntries = entries.filter((e) => e.shift === shift);
    text += `🕐 <b>${shift} Shift:</b>\n`;
    shiftEntries.forEach((e, i) => {
      text += `  ${i + 1}. ${e.employeeName}${e.notes ? ` <i>(${e.notes})</i>` : ""}\n`;
    });
    text += "\n";
  }

  text += `<b>Total Staff:</b> ${entries.length}\n\n`;
  text += `─────────────────\n`;
  text += `Approve to send this roster email to management.\n`;
  text += `Click <b>✏️ Request Changes</b> to modify the list.`;
  return text;
}

export async function runRosterJob(
  triggerType: "scheduled" | "manual" = "scheduled"
): Promise<void> {
  const today = getAppDateString();
  console.log(`[RosterJob] Starting for ${today}`);

  // Create job record
  const startedAt = new Date();
  const [job] = await db
    .insert(jobRuns)
    .values({
      jobType: "roster",
      status: "pending",
      triggerType,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .returning();

  const jobId = job!.id;
  const retryBudget = createJobRetryBudget();
  let emailAccepted = false;
  let retryNoticeSent = false;
  markJobRunnerActive(jobId);

  try {
    const holiday = await isHoliday(today);
    if (holiday) {
      await db
        .update(jobRuns)
        .set({ status: "holiday", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      await sendNotification(
        `🏖️ <b>Roster Job #${jobId} Skipped</b>\n${today} is ${escapeTelegramHtml(holiday.name)}. No roster email was generated.`
      );
      console.log(`[RosterJob #${jobId}] Skipped: ${holiday.name}`);
      return;
    }

    // Fetch today's roster
    let entries = await db
      .select()
      .from(rosterEntries)
      .where(eq(rosterEntries.date, today))
      .orderBy(asc(rosterEntries.id));

    const legacyHolidayEntry = entries.find(
      (entry) =>
        entry.shift.toLowerCase() === "holiday" ||
        /^(holiday|durga puja)$/i.test(entry.employeeName.trim())
    );
    if (legacyHolidayEntry) {
      await db
        .update(jobRuns)
        .set({ status: "holiday", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      await sendNotification(
        `🏖️ <b>Roster Job #${jobId} Skipped</b>\n${today} is marked as ${escapeTelegramHtml(legacyHolidayEntry.employeeName)}. No roster email was generated.`
      );
      console.log(`[RosterJob #${jobId}] Skipped: legacy holiday marker found`);
      return;
    }

    if (entries.length === 0) {
      await sendNotification(
        `⚠️ <b>Roster Job #${jobId}</b>: No roster entries found for ${today}. Please upload the roster first.`
      );
      await db
        .update(jobRuns)
        .set({ status: "error", error: "No roster entries for today", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      return;
    }

    let rosterList: RosterEntry[] = entries.map((e) => ({
      employeeName: e.employeeName,
      shift: e.shift,
      notes: e.notes,
    }));

    await db
      .update(jobRuns)
      .set({
        status: "waiting_confirm",
        previewData: rosterList,
        updatedAt: new Date(),
      })
      .where(eq(jobRuns.id, jobId));

    // Send Telegram preview
    const previewText = buildTelegramPreview(rosterList, today);
    const { approved, adjustment } = await sendConfirmationRequest(jobId, previewText);

    if (!approved) {
      await db
        .update(jobRuns)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      console.log(`[RosterJob #${jobId}] Rejected by manager`);
      return;
    }

    // Apply adjustments if any
    if (adjustment) {
      rosterList = applyAdjustments(rosterList, adjustment);
      await sendNotification(
        `✅ <b>Roster Job #${jobId}</b>: Adjustments applied. Sending email now…`
      ).catch((notifyError: unknown) =>
        console.error(`[RosterJob #${jobId}] Could not send adjustment notification:`, notifyError)
      );
    }

    // Build & send email
    const html = buildRosterEmailHtml(rosterList, today);
    const subject = `Engineers Responsible for the ${format(parseISO(today), "dd.MM.yyyy")}`;
    await db
      .update(jobRuns)
      .set({ adjustments: adjustment, updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));
    if (!(await claimJobDelivery(jobId))) {
      console.log(`[RosterJob #${jobId}] Another runner already claimed delivery`);
      return;
    }
    const { delivery, emailRecipients } = await retryImmediatelyUntilSuccessful(
      `RosterJob #${jobId}`,
      retryBudget,
      async () => {
        const recipients = await getEmailRecipients();
        const result = await sendEmail({
          to: recipients.rosterTo,
          cc: recipients.rosterCc,
          subject,
          html,
        });
        return { delivery: result, emailRecipients: recipients };
      },
      async (attempt, error) => {
        const message = error instanceof Error ? error.message : String(error);
        const willRetry = retryBudget.retriesRemaining > 0;
        await db
          .update(jobRuns)
          .set({
            error: message,
            status: willRetry ? "retrying" : "error",
            ...(willRetry ? { retryCount: sql`${jobRuns.retryCount} + 1` } : {}),
            updatedAt: new Date(),
          })
          .where(eq(jobRuns.id, jobId));
        if (!retryNoticeSent) {
          retryNoticeSent = true;
          const retriesRemaining = retryBudget.retriesRemaining;
          const retryStatus = willRetry
            ? `Retrying immediately (${retriesRemaining} ${retriesRemaining === 1 ? "retry" : "retries"} remaining).`
            : "No retries remain; the job will be marked failed.";
          await sendNotification(
            `⚠️ <b>Roster Job #${jobId}</b>: Email attempt ${attempt} failed. ${retryStatus}\n<code>${escapeTelegramHtml(message)}</code>`
          );
        }
      }

    );
    emailAccepted = true;

    const emailSentAt = new Date();
    await retryImmediatelyUntilSuccessful(
      `RosterJob #${jobId} completion update`,
      retryBudget,
      async () => {
        await db
          .update(jobRuns)
          .set({ status: "sent", emailSentAt, error: null, updatedAt: emailSentAt })
          .where(eq(jobRuns.id, jobId));
      },
      async (attempt, error) => {
        console.error(`[RosterJob #${jobId}] Could not record accepted email (attempt ${attempt}):`, error);
      }
    );

    await sendNotification(
      `✅ <b>Roster Email Accepted by SMTP</b>\n` +
        `📅 ${today}\n👥 ${rosterList.length} staff\n` +
        `📧 To: ${escapeTelegramHtml(emailRecipients.rosterTo.join(", "))}\n` +
        `📨 Accepted: ${escapeTelegramHtml(delivery.accepted.join(", "))}\n` +
        `⚠️ Rejected: ${escapeTelegramHtml(delivery.rejected.join(", ") || "none")}\n` +
        `🆔 Message ID: <code>${escapeTelegramHtml(delivery.messageId)}</code>\n` +
        `<i>SMTP acceptance does not confirm Inbox delivery.</i>`
    ).catch((notifyError: unknown) =>
      console.error(`[RosterJob #${jobId}] Could not send success notification:`, notifyError)
    );

    console.log(`[RosterJob #${jobId}] Email sent successfully`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (emailAccepted) {
      console.error(`[RosterJob #${jobId}] Email was accepted by SMTP, but post-delivery processing failed:`, msg);
      return;
    }
    console.error(`[RosterJob #${jobId}] Error:`, msg);
    await db
      .update(jobRuns)
      .set({ status: "error", error: msg, updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));
    await sendNotification(
      `❌ <b>Roster Job #${jobId} Failed</b>\n<code>${msg}</code>`
    );
  } finally {
    markJobRunnerInactive(jobId);
  }
}

export async function resumeApprovedRosterJob(jobRunId: number): Promise<void> {
  markJobRunnerActive(jobRunId);
  let emailAccepted = false;
  try {
    const [job] = await db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.id, jobRunId))
      .limit(1);
    if (!job || job.jobType !== "roster" || !Array.isArray(job.previewData)) {
      throw new Error(`Cannot resume roster job #${jobRunId}: saved preview data is missing`);
    }
    if (!(await claimJobDelivery(jobRunId))) {
      console.log(`[RosterJob #${jobRunId}] Another runner already claimed delivery`);
      return;
    }

    const rosterList = job.previewData as RosterEntry[];
    const adjustedList = job.adjustments
      ? applyAdjustments(rosterList, job.adjustments)
      : rosterList;
    const today = getAppDateString(job.createdAt ?? new Date());
    const html = buildRosterEmailHtml(adjustedList, today);
    const subject = `Engineers Responsible for the ${format(parseISO(today), "dd.MM.yyyy")}`;
    const retryBudget = createJobRetryBudget(job.retryCount);
    const { delivery, emailRecipients } = await retryImmediatelyUntilSuccessful(
      `RosterJob #${jobRunId} resumed`,
      retryBudget,
      async () => {
        const recipients = await getEmailRecipients();
        const result = await sendEmail({
          to: recipients.rosterTo,
          cc: recipients.rosterCc,
          subject,
          html,
        });
        return { delivery: result, emailRecipients: recipients };
      },
      async (_attempt, error) => {
        const message = error instanceof Error ? error.message : String(error);
        const willRetry = retryBudget.retriesRemaining > 0;
        await db
          .update(jobRuns)
          .set({
            error: message,
            status: willRetry ? "retrying" : "error",
            ...(willRetry ? { retryCount: sql`${jobRuns.retryCount} + 1` } : {}),
            updatedAt: new Date(),
          })
          .where(eq(jobRuns.id, jobRunId));
      }
    );
    emailAccepted = true;
    const emailSentAt = new Date();
    await db
      .update(jobRuns)
      .set({ status: "sent", emailSentAt, error: null, updatedAt: emailSentAt })
      .where(eq(jobRuns.id, jobRunId));
    await sendNotification(
      `✅ <b>Roster Email Accepted by SMTP</b>\n` +
        `📅 ${today}\n👥 ${adjustedList.length} staff\n` +
        `📧 To: ${escapeTelegramHtml(emailRecipients.rosterTo.join(", "))}\n` +
        `📨 Accepted: ${escapeTelegramHtml(delivery.accepted.join(", "))}\n` +
        `⚠️ Rejected: ${escapeTelegramHtml(delivery.rejected.join(", ") || "none")}\n` +
        `🆔 Message ID: <code>${escapeTelegramHtml(delivery.messageId)}</code>\n` +
        `<i>SMTP acceptance does not confirm Inbox delivery.</i>`
    ).catch((error: unknown) =>
      console.error(`[RosterJob #${jobRunId}] Could not send success notification:`, error)
    );
  } catch (error: unknown) {
    if (!emailAccepted) {
      const message = error instanceof Error ? error.message : String(error);
      await db
        .update(jobRuns)
        .set({ status: "error", error: message, updatedAt: new Date() })
        .where(eq(jobRuns.id, jobRunId));
      await sendNotification(
        `❌ <b>Resumed Roster Job #${jobRunId} Failed</b>\n<code>${escapeTelegramHtml(message)}</code>`
      );
    }
    throw error;
  } finally {
    markJobRunnerInactive(jobRunId);
  }
}

registerJobResumer("roster", resumeApprovedRosterJob);
