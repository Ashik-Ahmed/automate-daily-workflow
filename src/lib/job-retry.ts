import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";

export const MAX_JOB_RETRIES = 3;

export interface JobRetryBudget {
  retriesRemaining: number;
}

export function retryDelayMs(attempt: number): number {
  const capped = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.floor(capped * (0.5 + Math.random() * 0.5));
}

export function createJobRetryBudget(retriesAlreadyUsed = 0): JobRetryBudget {
  return {
    retriesRemaining: Math.max(0, MAX_JOB_RETRIES - retriesAlreadyUsed),
  };
}

export async function claimJobDelivery(jobRunId: number): Promise<boolean> {
  const now = new Date();
  const [claimedJob] = await db
    .update(jobRuns)
    .set({ status: "sending", workflowStep: "delivery", deliveryOutcome: null, error: null, nextAttemptAt: null, leaseExpiresAt: new Date(now.getTime() + 5 * 60_000), updatedAt: now })
    .where(and(eq(jobRuns.id, jobRunId), eq(jobRuns.status, "confirmed")))
    .returning({ id: jobRuns.id });
  return !!claimedJob;
}

export async function retryImmediatelyUntilSuccessful<T>(
  jobLabel: string,
  retryBudget: JobRetryBudget,
  operation: (attempt: number) => Promise<T>,
  onFailure: (attempt: number, error: unknown, retryAt?: Date) => Promise<void>
): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      const willRetry = retryBudget.retriesRemaining > 0 && !(
        typeof error === "object" && error !== null && "retryable" in error && error.retryable === false
      );
      const retryAt = willRetry ? new Date(Date.now() + retryDelayMs(attempt)) : undefined;
      if (
        typeof error === "object" && error !== null &&
        "retryable" in error && error.retryable === false
      ) {
        await onFailure(attempt, error, retryAt).catch((reportingError: unknown) =>
          console.error(`[${jobLabel}] Could not record non-retryable outcome:`, reportingError)
        );
        throw error;
      }
      console.error(
        `[${jobLabel}] Attempt ${attempt} failed; ${willRetry ? "retry scheduled" : "retry limit reached"}:`,
        error
      );
      try {
        await onFailure(attempt, error, retryAt);
      } catch (reportingError: unknown) {
        console.error(`[${jobLabel}] Could not record retry failure:`, reportingError);
      }
      if (retryBudget.retriesRemaining === 0) {
        throw error;
      }
      retryBudget.retriesRemaining -= 1;
      if (retryAt) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, retryAt.getTime() - Date.now())));
      }
    }
  }
}
