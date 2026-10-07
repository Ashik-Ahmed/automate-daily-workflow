/**
 * Telegram bot singleton — long-poll mode.
 * Uses the new node-telegram-bot-api v2 (Bot class, Context, typed API).
 */

import { Bot, Context, InputFile } from "node-telegram-bot-api";
import { and, desc, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";
import { cfg } from "./config";

let _bot: Bot | null = null;
let _pollingStarted = false;

export function getBot(): Bot {
  if (!_bot) {
    if (!cfg.telegram.token) {
      throw new Error("TELEGRAM_BOT_TOKEN is not set");
    }
    _bot = new Bot(cfg.telegram.token);
    console.log("[Telegram] Bot instance created");
  }
  return _bot;
}

export async function startPolling() {
  if (_pollingStarted) return;
  _pollingStarted = true;
  const bot = getBot();
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
  } catch (err: unknown) {
    _pollingStarted = false;
    throw err;
  }

  // Explicitly request callbacks; Telegram may retain an older allowed_updates filter.
  bot.startPolling(undefined, {
    allowedUpdates: ["message", "callback_query"],
    onError: (err) => console.error("[Telegram] polling request failed:", err),
  }).catch((err: unknown) => {
    console.error("[Telegram] polling stopped:", err);
    _pollingStarted = false;
  });
  console.log("[Telegram] Polling started (message, callback_query)");
}

// ─── Pending confirmation map ─────────────────────────────────────────────────
type ConfirmCallback = (
  approved: boolean,
  adjustment?: string,
  autoAccepted?: boolean
) => void;

interface PendingEntry {
  resolve: ConfirmCallback;
  messageId?: number;
  adjustmentPromptMessageId?: number;
  adjustmentMode: boolean;
  isPhoto: boolean;
}

const pendingConfirmations = new Map<number, PendingEntry>();
const activeJobRunners = new Set<number>();
const jobResumers = new Map<"roster" | "connectivity", (jobRunId: number) => Promise<void>>();
let _handlersRegistered = false;

export function registerJobResumer(
  jobType: "roster" | "connectivity",
  resume: (jobRunId: number) => Promise<void>
): void {
  jobResumers.set(jobType, resume);
}

export function markJobRunnerActive(jobRunId: number): void {
  activeJobRunners.add(jobRunId);
}

export function markJobRunnerInactive(jobRunId: number): void {
  activeJobRunners.delete(jobRunId);
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Wire callback_query and message handlers (called once at app startup) */
export function initConfirmationHandlers() {
  if (_handlersRegistered) return;
  _handlersRegistered = true;

  const bot = getBot();
  const chatId = cfg.telegram.chatId;

  bot.catch((err, ctx) => {
    console.error("[Telegram] Update handler failed:", err, ctx.update);
  });

  // Button click handler
  bot.on("callback_query", async (ctx: Context) => {
    const query = ctx.callbackQuery;
    if (!query) return;
    const data = query.data ?? "";
    const [action, idStr] = data.split(":");
    const jobRunId = Number(idStr);
    const callbackChatId = query.message?.chat.id.toString();

    if (callbackChatId !== chatId || !Number.isSafeInteger(jobRunId)) {
      await ctx.answerCallbackQuery({ text: "Invalid confirmation request.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Processing your response…" });
    console.log(`[Telegram] Callback received: ${action} for job #${jobRunId}`);

    const nextStatus =
      action === "approve"
        ? "confirmed"
        : action === "reject"
        ? "rejected"
        : action === "adjust"
        ? "waiting_adjustment"
        : undefined;

    if (!nextStatus) {
      await bot.api.sendMessage({ chat_id: chatId, text: "Unknown confirmation action." });
      return;
    }

    if (!activeJobRunners.has(jobRunId)) {
      const [currentJob] = await db
        .select({
          status: jobRuns.status,
          jobType: jobRuns.jobType,
          error: jobRuns.error,
        })
        .from(jobRuns)
        .where(eq(jobRuns.id, jobRunId))
        .limit(1);

      if (currentJob?.status === "sent") {
        await bot.api.sendMessage({
          chat_id: chatId,
          text: `Job #${jobRunId} has already been accepted by SMTP.`,
        });
        return;
      }

      const resumer = currentJob?.jobType === "roster" || currentJob?.jobType === "connectivity"
        ? jobResumers.get(currentJob.jobType)
        : undefined;
      const wasMarkedInterrupted =
        currentJob?.status === "error" &&
        currentJob.error?.startsWith("Confirmation was clicked after the app restarted;");
      const canResume =
        action === "approve" &&
        resumer &&
        (currentJob?.status === "waiting_confirm" ||
          currentJob?.status === "confirmed" ||
          wasMarkedInterrupted);

      if (canResume) {
        const [resumedJob] = await db
          .update(jobRuns)
          .set({ status: "confirmed", error: null, updatedAt: new Date() })
          .where(
            and(
              eq(jobRuns.id, jobRunId),
              or(
                eq(jobRuns.status, "waiting_confirm"),
                eq(jobRuns.status, "confirmed"),
                ...(wasMarkedInterrupted ? [eq(jobRuns.status, "error")] : [])
              )
            )
          )
          .returning({ id: jobRuns.id });

        if (resumedJob) {
          await bot.api.sendMessage({
            chat_id: chatId,
            text: `Approval accepted. Resuming Job #${jobRunId} and its email delivery now.`,
          });
          void resumer(jobRunId).catch((error: unknown) =>
            console.error(`[Telegram] Could not resume job #${jobRunId}:`, error)
          );
          return;
        }
      }

      if (action === "reject" && currentJob?.status === "waiting_confirm") {
        await db
          .update(jobRuns)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(and(eq(jobRuns.id, jobRunId), eq(jobRuns.status, "waiting_confirm")));
        await bot.api.sendMessage({ chat_id: chatId, text: `Job #${jobRunId} was cancelled.` });
        return;
      }

      await bot.api.sendMessage({
        chat_id: chatId,
        text:
          currentJob?.status === "sending" || currentJob?.status === "retrying"
            ? `Job #${jobRunId} is already processing or retrying delivery. This click will not start another email send.`
            : `Job #${jobRunId} has no active runner to handle this action. Refresh the dashboard; if it is failed, trigger it again.`,
      });
      return;
    }

    const [updatedJob] = await db
      .update(jobRuns)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(and(eq(jobRuns.id, jobRunId), eq(jobRuns.status, "waiting_confirm")))
      .returning({ id: jobRuns.id, jobType: jobRuns.jobType });

    if (!updatedJob) {
      const [currentJob] = await db
        .select({ status: jobRuns.status })
        .from(jobRuns)
        .where(eq(jobRuns.id, jobRunId))
        .limit(1);

      if (action === "approve" && (currentJob?.status === "confirmed" || currentJob?.status === "sent")) {
        await bot.api.sendMessage({
          chat_id: chatId,
          text: `Job #${jobRunId} has already been approved${currentJob.status === "sent" ? " and its email was accepted by SMTP" : " and is processing the email"}. Refresh the dashboard for the latest status.`,
        });
        return;
      }

      if (action === "reject" && currentJob?.status === "rejected") {
        await bot.api.sendMessage({
          chat_id: chatId,
          text: `Job #${jobRunId} was already cancelled.`,
        });
        return;
      }

      console.warn(
        `[Telegram] Could not apply ${action} to job #${jobRunId}; current status: ${currentJob?.status ?? "not found"}`
      );
      await bot.api.sendMessage({
        chat_id: chatId,
        text: currentJob
          ? `Job #${jobRunId} is currently "${currentJob.status}", so this confirmation button cannot be applied. Refresh the dashboard.`
          : `Job #${jobRunId} was not found. Refresh the dashboard and check that the app is connected to the expected database.`,
      });
      return;
    }

    const entry = pendingConfirmations.get(jobRunId);
    if (action === "approve" || action === "reject") {
      pendingConfirmations.delete(jobRunId);
      entry?.resolve(action === "approve");
      const finalText =
        action === "approve"
          ? `✅ <b>Approved!</b> Email will be sent now. (Job #${jobRunId})`
          : `❌ <b>Cancelled.</b> Email was NOT sent. (Job #${jobRunId})`;
      const messageId = query.message!.message_id;
      const replyMarkup = { inline_keyboard: [] };
      if (entry?.isPhoto || (query.message && "photo" in query.message)) {
        await bot.api.editMessageCaption({
          chat_id: chatId,
          message_id: messageId,
          caption: finalText,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      } else {
        await bot.api.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          text: finalText,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
      }
    } else {
      if (entry) entry.adjustmentMode = true;
      const adjustmentPrompt =
        updatedJob.jobType === "connectivity"
          ? `✏️ <b>What manager's note should be added to the connectivity email for Job #${jobRunId}?</b>\n<i>Example: "All nodes are active except Teletalk; no messages are queued for Teletalk." Live ASA and queue data will still be reported as captured.</i>`
          : `✏️ <b>What roster changes should be applied for Job #${jobRunId}?</b>\n<i>Separate commands with semicolons. Examples: "Replace Mr. Rifat with - in the Daytime shift; Replace Mr. Ashik with Mr. Shawon in the Morning Report shift" or "Swap Mr. Ashik and Mr. Shawon shifts". Use "Remove &lt;name&gt;" to remove an entry.</i>`;
      const promptMessage = await bot.api.sendMessage({
        chat_id: chatId,
        text: adjustmentPrompt,
        parse_mode: "HTML",
      });
      if (entry) entry.adjustmentPromptMessageId = promptMessage.message_id;
      await db
        .update(jobRuns)
        .set({ telegramMessageId: promptMessage.message_id, updatedAt: new Date() })
        .where(eq(jobRuns.id, jobRunId));
    }
  });

  // Text message handler — catches adjustment replies
  bot.on("message", async (ctx: Context) => {
    const msg = ctx.message;
    if (!msg?.text || msg.chat.id.toString() !== chatId) return;

    const pendingJobs = await db
      .select({ id: jobRuns.id, telegramMessageId: jobRuns.telegramMessageId })
      .from(jobRuns)
      .where(eq(jobRuns.status, "waiting_adjustment"))
      .orderBy(desc(jobRuns.updatedAt))
      .limit(20);
    if (pendingJobs.length === 0) return;

    const replyToMessageId = msg.reply_to_message?.message_id;
    const repliedPrompt = pendingJobs.find(
      (job) => job.telegramMessageId === replyToMessageId
    );
    const pendingJob =
      repliedPrompt ?? (pendingJobs.length === 1 ? pendingJobs[0] : undefined);

    if (!pendingJob) {
      await bot.api.sendMessage({
        chat_id: chatId,
        text: "Several email changes are waiting. Reply directly to the matching change prompt so I can apply your note to the correct email.",
      });
      return;
    }

    const adjustment = msg.text.trim();
    const [updatedJob] = await db
      .update(jobRuns)
      .set({ status: "confirmed", adjustments: adjustment, updatedAt: new Date() })
      .where(and(eq(jobRuns.id, pendingJob.id), eq(jobRuns.status, "waiting_adjustment")))
      .returning({ id: jobRuns.id });
    if (!updatedJob) return;

    pendingConfirmations.get(pendingJob.id)?.resolve(true, adjustment);
    pendingConfirmations.delete(pendingJob.id);
    const [job] = await db
      .select({ jobType: jobRuns.jobType })
      .from(jobRuns)
      .where(eq(jobRuns.id, pendingJob.id))
      .limit(1);
    await bot.api.sendMessage({
      chat_id: chatId,
      text:
        job?.jobType === "connectivity"
          ? `📝 <b>Manager's note added to connectivity email:</b> "${escapeTelegramHtml(adjustment)}"`
          : `📝 <b>Roster adjustment noted:</b> "${escapeTelegramHtml(adjustment)}"\n\nProcessing changes for Job #${pendingJob.id}…`,
      parse_mode: "HTML",
    });
  });
}

/** Send a preview message with ✅ Approve / ✏️ Changes / ❌ Cancel buttons */
export async function sendConfirmationRequest(
  jobRunId: number,
  text: string,
  options: { photo?: Uint8Array } = {}
): Promise<{ approved: boolean; adjustment?: string; autoAccepted?: boolean }> {
  const bot = getBot();
  const chatId = cfg.telegram.chatId;
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID is not set");

  const replyMarkup = {
    inline_keyboard: [
      [
        { text: "✅ Send Email", callback_data: `approve:${jobRunId}` },
        { text: "✏️ Request Changes", callback_data: `adjust:${jobRunId}` },
        { text: "❌ Cancel", callback_data: `reject:${jobRunId}` },
      ],
    ],
  };
  try {
    const result = options.photo
      ? await bot.api.sendPhoto({
          chat_id: chatId,
          photo: new InputFile(options.photo, {
            filename: "asa-output.png",
            contentType: "image/png",
          }),
          caption: text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        })
      : await bot.api.sendMessage({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });

    await db
      .update(jobRuns)
      .set({ telegramMessageId: result.message_id, updatedAt: new Date() })
      .where(eq(jobRuns.id, jobRunId));

    return await new Promise((resolve) => {
    let settled = false;
    const finish = (
      approved: boolean,
      adjustment?: string,
      autoAccepted = false
    ) => {
      if (settled) return;
      settled = true;
      clearInterval(pollInterval);
      clearTimeout(timeout);
      pendingConfirmations.delete(jobRunId);
      resolve({ approved, adjustment, autoAccepted });
    };

    pendingConfirmations.set(jobRunId, {
      resolve: finish,
      messageId: result.message_id,
      adjustmentMode: false,
      isPhoto: !!options.photo,
    });

    const pollInterval = setInterval(async () => {
      try {
        const [job] = await db
          .select({ status: jobRuns.status, adjustments: jobRuns.adjustments })
          .from(jobRuns)
          .where(eq(jobRuns.id, jobRunId))
          .limit(1);
        if (job?.status === "confirmed") {
          finish(true, job.adjustments ?? undefined);
        } else if (job?.status === "rejected" || job?.status === "error") {
          finish(false);
        }
      } catch (err: unknown) {
        console.error(`[Telegram] Could not check confirmation for job #${jobRunId}:`, err);
      }
    }, 1000);

    // Timeout after configured duration
    const timeout = setTimeout(async () => {
      if (!settled) {
        try {
          const [autoApprovedJob] = await db
            .update(jobRuns)
            .set({ status: "confirmed", updatedAt: new Date() })
            .where(
              and(
                eq(jobRuns.id, jobRunId),
                or(
                  eq(jobRuns.status, "waiting_confirm"),
                  eq(jobRuns.status, "waiting_adjustment")
                )
              )
            )
            .returning({ id: jobRuns.id });

          if (autoApprovedJob) {
            const timeoutMessage =
              `⏰ <b>No response within ${Math.round(cfg.confirmTimeout / 60000)} minutes.</b>\n` +
              `Automatically approved; processing the email now. (Job #${jobRunId})`;
            const replyMarkup = { inline_keyboard: [] };
            const editRequest = options.photo
              ? bot.api.editMessageCaption({
                  chat_id: chatId,
                  message_id: result.message_id,
                  caption: timeoutMessage,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                })
              : bot.api.editMessageText({
                  chat_id: chatId,
                  message_id: result.message_id,
                  text: timeoutMessage,
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                });
            await editRequest.catch((err: unknown) => {
              console.error(
                `[Telegram] Could not update auto-approved confirmation for job #${jobRunId}:`,
                err
              );
            });
            finish(true, undefined, true);
          }
        } catch (err: unknown) {
          console.error(
            `[Telegram] Could not auto-approve job #${jobRunId} after timeout:`,
            err
          );
          finish(false);
        }
      }
    }, cfg.confirmTimeout);
    });
  } catch (error: unknown) {
    pendingConfirmations.delete(jobRunId);
    throw error;
  }
}

/** Send a plain notification (no confirmation needed) */
export async function sendNotification(text: string) {
  const bot = getBot();
  const chatId = cfg.telegram.chatId;
  if (!chatId) return;
  await bot.api.sendMessage({ chat_id: chatId, text, parse_mode: "HTML" });
}