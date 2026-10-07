/**
 * Called once on server boot to initialise the scheduler.
 * Next.js instrumentation hook triggers this.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true });
}
