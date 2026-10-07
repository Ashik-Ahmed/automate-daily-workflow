/**
 * Next.js Instrumentation Hook
 * Runs once when the server starts — initialises the scheduler.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initScheduler } = await import("./lib/scheduler");
    await initScheduler();
  }
}
