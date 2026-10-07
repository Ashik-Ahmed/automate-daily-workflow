import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";

export const MAX_JOB_RETRIES = 3;

export interface JobRetryBudget {
  retriesRemaining: number;
}

export function createJobRetryBudget(retriesAlreadyUsed = 0): JobRetryBudget {
  return {
    retriesRemaining: Math.max(0, MAX_JOB_RETRIES - retriesAlreadyUsed),
  };
}

export async function claimJobDelivery(jobRunId: number): Promise<boolean> {
  const [claimedJob] = await db
    .update(jobRuns)
    .set({ status: "sending", error: null, updatedAt: new Date() })
    .where(and(eq(jobRuns.id, jobRunId), eq(jobRuns.status, "confirmed")))
    .returning({ id: jobRuns.id });
  return !!claimedJob;
}

export async function retryImmediatelyUntilSuccessful<T>(
  jobLabel: string,
  retryBudget: JobRetryBudget,
  operation: (attempt: number) => Promise<T>,
  onFailure: (attempt: number, error: unknown) => Promise<void>
): Promise<T> {
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await operation(attempt);
    } catch (error: unknown) {
      const willRetry = retryBudget.retriesRemaining > 0;
      console.error(
        `[${jobLabel}] Attempt ${attempt} failed; ${willRetry ? "retrying immediately" : "retry limit reached"}:`,
        error
      );
      try {
        await onFailure(attempt, error);
      } catch (reportingError: unknown) {
        console.error(`[${jobLabel}] Could not record retry failure:`, reportingError);
      }
      if (retryBudget.retriesRemaining === 0) {
        throw error;
      }
      retryBudget.retriesRemaining -= 1;
    }
  }
}
