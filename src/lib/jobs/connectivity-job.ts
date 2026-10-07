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
import { renderAsaOutputImage } from "@/lib/asa-output-image";
import { formatAppDateLabel, getAppDateString } from "@/lib/app-time";
import { createJobRetryBudget, retryImmediatelyUntilSuccessful } from "@/lib/job-retry";

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
  checkDate: string,
  upCount: number,
  downCount: number
): string {
  const dateDisplay = formatAppDateLabel(checkDate, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    weekday: "long",
  });

  return (
    `🔗 <b>CONNECTIVITY CHECK PREVIEW</b>\n` +
    `📅 ${dateDisplay}\n\n` +
    `✅ <b>UP:</b> ${upCount} | ❌ <b>DOWN:</b> ${downCount}\n\n` +
    `<b>📟 ASA Output (show crypto isakmp sa)</b>\n` +
    `The complete ASA output is attached as an image.\n\n` +
    `─────────────────\n` +
    `Approve to update Excel & send email to management.\n` +
    `Click <b>❌ Cancel</b> to abort.`
  );
}

export async function runConnectivityJob(
  triggerType: "scheduled" | "manual" = "scheduled"
): Promise<void> {
  const today = getAppDateString();
  console.log(`[ConnectivityJob] Starting for ${today}`);

  const startedAt = new Date();
  const [job] = await db
    .insert(jobRuns)
    .values({
      jobType: "connectivity",
      status: "pending",
      triggerType,
      createdAt: startedAt,
      updatedAt: startedAt,
    })
    .returning();

  const jobId = job!.id;
  const retryBudget = createJobRetryBudget();
  let emailAccepted = false;
  let deliveryRetryNoticeSent = false;

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

    const asaResult = await fetchAsaConnectivity();

    if (!asaResult.success) {
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
        status: "pending",
        previewData: { parsed, upCount, downCount, unknownCount },
        updatedAt: new Date(),
      })
      .where(eq(jobRuns.id, jobId));

    const qadminCapture = await retryImmediatelyUntilSuccessful(
      `ConnectivityJob #${jobId} QAdmin capture`,
      retryBudget,
      () => captureQadminQueueScreenshot(),
      async (_attempt, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(jobRuns)
          .set({ error: message, updatedAt: new Date() })
          .where(eq(jobRuns.id, jobId));
      }
    );
    await db
      .update(jobRuns)
      .set({ status: "waiting_confirm", error: null, updatedAt: new Date() })
      .where(eq(jobRuns.id, jobId));
    if (!asaResult.success) {
      await sendNotification(
        `❌ <b>Connectivity Job #${jobId} SSH Failed</b>\n<code>${escapeTelegramHtml(asaResult.error ?? "Unknown SSH error")}</code>\n\nUsing mock/empty output.`
      );
    }
    await sendNotification(
      `🔄 <b>Connectivity Job #${jobId}</b>: ASA and QAdmin data captured. Preparing confirmation…`
    );

    // Step 2: Telegram preview
    const previewText = buildTelegramPreview(today, upCount, downCount);
    const asaOutputImage = await renderAsaOutputImage(asaResult.output);
    const { approved, adjustment } = await sendConfirmationRequest(
      jobId,
      previewText,
      { photo: asaOutputImage }
    );

    if (!approved) {
      await db
        .update(jobRuns)
        .set({ status: "rejected", updatedAt: new Date() })
        .where(eq(jobRuns.id, jobId));
      console.log(`[ConnectivityJob #${jobId}] Rejected by manager`);
      return;
    }

    const html = buildConnectivityEmailHtml(today, adjustment);
    const dateDisplay = format(parseISO(today), "do MMMM yyyy");
    const subject = `Daily connectivity status check dated on the ${dateDisplay}`;
    const { delivery, emailRecipients } = await retryImmediatelyUntilSuccessful(
      `ConnectivityJob #${jobId}`,
      retryBudget,
      async () => {
        await db
          .update(jobRuns)
          .set({ status: "confirmed", updatedAt: new Date() })
          .where(eq(jobRuns.id, jobId));
        let excelPath: string | undefined;
        try {
          excelPath = await appendConnectivitySheet(asaResult.output, today);
          console.log(`[ConnectivityJob #${jobId}] Excel updated: ${excelPath}`);
        } catch (excelErr: unknown) {
          const message = excelErr instanceof Error ? excelErr.message : String(excelErr);
          console.warn(`[ConnectivityJob #${jobId}] Excel error:`, message);
          await sendNotification(
            `⚠️ <b>Job #${jobId}</b>: Excel update failed: <code>${escapeTelegramHtml(message)}</code>. Sending email without attachment.`
          );
        }

        const recipients = await getEmailRecipients();
        const result = await sendEmail({
          to: recipients.connectivityTo,
          cc: recipients.connectivityCc,
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
        return { delivery: result, emailRecipients: recipients };
      },
      async (attempt, error) => {
        const message = error instanceof Error ? error.message : String(error);
        await db
          .update(jobRuns)
          .set({ error: message })
          .where(eq(jobRuns.id, jobId));
        if (!deliveryRetryNoticeSent) {
          deliveryRetryNoticeSent = true;
          const retryStatus =
            retryBudget.retriesRemaining > 0
              ? "Retrying immediately."
              : "No retries remain; the job will be marked failed.";
          await sendNotification(
            `⚠️ <b>Connectivity Job #${jobId}</b>: Delivery attempt ${attempt} failed. ${retryStatus}\n<code>${escapeTelegramHtml(message)}</code>`
          );
        }
      }
    );
    emailAccepted = true;

    const emailSentAt = new Date();
    await retryImmediatelyUntilSuccessful(
      `ConnectivityJob #${jobId} completion update`,
      retryBudget,
      async () => {
        await db
          .update(jobRuns)
          .set({ status: "sent", emailSentAt, error: null, updatedAt: emailSentAt })
          .where(eq(jobRuns.id, jobId));
      },
      async (attempt, error) => {
        console.error(
          `[ConnectivityJob #${jobId}] Could not record accepted email (attempt ${attempt}):`,
          error
        );
      }
    );

    await sendNotification(
      `✅ <b>Connectivity Email Accepted by SMTP</b>\n` +
        `📅 ${today}\n` +
        `✅ UP: ${upCount} | ❌ DOWN: ${downCount} | ❓ Unknown: ${unknownCount}\n` +
        `📧 To: ${escapeTelegramHtml(emailRecipients.connectivityTo.join(", "))}\n` +
        `📨 Accepted: ${escapeTelegramHtml(delivery.accepted.join(", "))}\n` +
        `⚠️ Rejected: ${escapeTelegramHtml(delivery.rejected.join(", ") || "none")}\n` +
        `🆔 Message ID: <code>${escapeTelegramHtml(delivery.messageId)}</code>\n` +
        `<i>SMTP acceptance does not confirm Inbox delivery.</i>`
    ).catch((notifyError: unknown) =>
      console.error(`[ConnectivityJob #${jobId}] Could not send success notification:`, notifyError)
    );

    console.log(`[ConnectivityJob #${jobId}] Email sent successfully`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (emailAccepted) {
      console.error(`[ConnectivityJob #${jobId}] Email was accepted by SMTP, but post-delivery processing failed:`, msg);
      return;
    }
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
