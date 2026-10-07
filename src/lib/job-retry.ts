export const MAX_JOB_RETRIES = 3;

export interface JobRetryBudget {
  retriesRemaining: number;
}

export function createJobRetryBudget(retriesAlreadyUsed = 0): JobRetryBudget {
  return {
    retriesRemaining: Math.max(0, MAX_JOB_RETRIES - retriesAlreadyUsed),
  };
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
