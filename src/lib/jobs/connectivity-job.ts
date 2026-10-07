/**
 * Daily Connectivity Email Job
 * 1. SSH into ASA, run show crypto isakmp sa
 * 2. Send Telegram preview + confirmation
 * 3. Append results to Excel sheet
 * 4. Send email with Excel attachment
 */

import { format, parseISO } from "date-fns";
import { db } from "@/db";
import { jobRuns, connectivityResults } from "@/db/schema";
import { eq } from "drizzle-orm";
import { escapeTelegramHtml, sendConfirmationRequest, sendNotification } from "@/lib/telegram";
import { sendEmail } from "@/lib/mailer";
import { fetchAsaConnectivity, parseIsakmpOutput } from "@/lib/ssh-asa";
import { appendConnectivitySheet } from "@/lib/excel";
import { getEmailRecipients } from "@/lib/email-recipients";
import { cfg } from "@/lib/config";
import { captureQadminQueueScreenshot } from "@/lib/qadmin";
import { isHoliday } from "@/lib/holiday-calendar";

function buildConnectivityEmailHtml(
  checkDate: string,
  managerNote?: string
): string {
  const dateDisplay = format(parseISO(checkDate), "do MMMM yyyy");
  const managerNoteHtml = managerNote?.trim()
    ? `<p><strong>Manager's note:</strong> ${escapeHtml(managerNote.trim())}</p>`
    : "";

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;color:#111;font-size:14px">
  <p>Dear Sir,</p>
  <p>Daily connectivity status check dated on the ${dateDisplay} is attached with the mail. All the nodes are active &amp; All the service checks are okay.</p>
  ${managerNoteHtml}
  <p><img src="cid:qadmin" alt="Queue Management status" style="display:block;width:100%;max-width:1106px;height:auto;border:0" /></p>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTelegramPreview(
  rawOutput: string,
  checkDate: string,
  upCount: number,
  downCount: number
): string {
  const dateDisplay = format(new Date(checkDate), "dd MMM yyyy (EEEE)");
  // Truncate output for Telegram (max 4096 chars)
  const truncated =
    rawOutput.length > 2000 ? rawOutput.slice(0, 2000) + "\n…[truncated]" : rawOutput;

  return (
    `🔗 <b>CONNECTIVITY CHECK PREVIEW</b>\n` +
    `📅 ${dateDisplay}\n\n` +
    `✅ <b>UP:</b> ${upCount} | ❌ <b>DOWN:</b> ${downCount}\n\n` +
    `<b>📟 ASA Output (show crypto isakmp sa):</b>\n` +
    `<pre>${escapeHtml(truncated)}</pre>\n\n` +
    `─────────────────\n` +
    `Approve to update Excel & send email to management.\n` +
    `Click <b>❌ Cancel</b> to abort.`
  );
}

export async function runConnectivityJob(
  triggerType: "scheduled" | "manual" = "scheduled"
): Promise<void> {
  const today = format(new Date(), "yyyy-MM-dd");
  console.log(`[ConnectivityJob] Starting for ${today}`);

  const [job] = await db
    .insert(jobRuns)
    .values({
      jobType: "connectivity",
      status: "pending",
      triggerType,
    })
    .returning();

  const jobId = job!.id;

  try {
    const holiday = await isHoliday(today);
    if (holiday) {
      await db
        .update(jobRuns)
        .set({ status: "holiday", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      await sendNotification(
        `🏖️ <b>Connectivity Job #${jobId} Skipped</b>\n${today} is ${escapeTelegramHtml(holiday.name)}. No connectivity check or email was generated.`
      );
      console.log(`[ConnectivityJob #${jobId}] Skipped: ${holiday.name}`);
      return;
    }

    // Step 1: SSH into ASA
    await db
      .update(jobRuns)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));

    await sendNotification(
      `🔄 <b>Connectivity Job #${jobId}</b>: Connecting to ASA firewall…`
    );

    const asaResult = await fetchAsaConnectivity();

    if (!asaResult.success) {
      await sendNotification(
        `❌ <b>Connectivity Job #${jobId} SSH Failed</b>\n<code>${asaResult.error}</code>\n\nUsing mock/empty output.`
      );
      // Don't abort — let manager still approve with error note
      asaResult.output = `[SSH Error: ${asaResult.error}]\nNo live data available.`;
    }

    const parsed = parseIsakmpOutput(asaResult.output);
    const upCount = parsed.filter((e) => e.status === "UP").length;
    const downCount = parsed.filter((e) => e.status === "DOWN").length;
    const unknownCount = parsed.filter((e) => e.status === "UNKNOWN").length;

    // Save to DB
    await db.insert(connectivityResults).values({
      checkDate: today,
      rawOutput: asaResult.output,
      parsedData: parsed,
      jobRunId: jobId,
    });

    await db
      .update(jobRuns)
      .set({
        status: "waiting_confirm",
        previewData: { parsed, upCount, downCount, unknownCount },
        updatedAt: new Date(),
      })
      .where(eq(jobRuns.id, jobId));

    // Step 2: Telegram preview
    const previewText = buildTelegramPreview(
      asaResult.output,
      today,
      upCount,
      downCount
    );
    const { approved, adjustment } = await sendConfirmationRequest(jobId, previewText);

    if (!approved) {
      await db
        .update(jobRuns)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      console.log(`[ConnectivityJob #${jobId}] Rejected by manager`);
      return;
    }

    await db
      .update(jobRuns)
      .set({ status: "confirmed", updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));

    // Capture the live outgoing queue before creating the report and email.
    const qadminCapture = await captureQadminQueueScreenshot();

    // Step 3: Append to Excel
    let excelPath: string | undefined;
    try {
      excelPath = await appendConnectivitySheet(asaResult.output, today);
      console.log(`[ConnectivityJob #${jobId}] Excel updated: ${excelPath}`);
    } catch (excelErr: unknown) {
      const msg = excelErr instanceof Error ? excelErr.message : String(excelErr);
      console.warn(`[ConnectivityJob #${jobId}] Excel error:`, msg);
      await sendNotification(
        `⚠️ <b>Job #${jobId}</b>: Excel update failed: <code>${msg}</code>. Sending email without attachment.`
      );
    }

    // Step 4: Send email
    const html = buildConnectivityEmailHtml(today, adjustment);
    const dateDisplay = format(parseISO(today), "do MMMM yyyy");
    const subject = `Daily connectivity status check dated on the ${dateDisplay}`;
    const emailRecipients = await getEmailRecipients();

    const delivery = await sendEmail({
      to: emailRecipients.connectivityTo,
      cc: emailRecipients.connectivityCc,
      subject,
      html,
      attachments: [
        ...(excelPath ? [{ filename: `Connectivity_${today}.xlsx`, path: excelPath }] : []),
        {
          filename: "qadmin.png",
          path: qadminCapture.screenshotPath,
          cid: "qadmin",
          contentDisposition: "inline",
        },
      ],
    });

    await db
      .update(jobRuns)
      .set({ status: "sent", emailSentAt: new Date(), updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));

    await sendNotification(
      `✅ <b>Connectivity Email Accepted by SMTP</b>\n` +
        `📅 ${today}\n` +
        `✅ UP: ${upCount} | ❌ DOWN: ${downCount} | ❓ Unknown: ${unknownCount}\n` +
        `📧 To: ${escapeTelegramHtml(emailRecipients.connectivityTo.join(", "))}\n` +
        `📨 Accepted: ${escapeTelegramHtml(delivery.accepted.join(", "))}\n` +
        `⚠️ Rejected: ${escapeTelegramHtml(delivery.rejected.join(", ") || "none")}\n` +
        `🆔 Message ID: <code>${escapeTelegramHtml(delivery.messageId)}</code>\n` +
        `<i>SMTP acceptance does not confirm Inbox delivery.</i>`
    );

    console.log(`[ConnectivityJob #${jobId}] Email sent successfully`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ConnectivityJob #${jobId}] Error:`, msg);
    await db
      .update(jobRuns)
      .set({ status: "error", error: msg, updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));
    await sendNotification(
      `❌ <b>Connectivity Job #${jobId} Failed</b>\n<code>${msg}</code>`
    );
  }
}
