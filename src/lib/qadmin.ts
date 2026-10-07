import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cfg } from "./config";
import { launchChromium } from "./playwright-browser";

export interface QadminQueueStatus {
  operator: string;
  queuedMessages: number;
}

export interface QadminCaptureResult {
  screenshotPath: string;
  queueStatus: QadminQueueStatus[];
}

export async function captureQadminQueueScreenshot(): Promise<QadminCaptureResult> {
  if (!cfg.qadmin.username || !cfg.qadmin.password) {
    throw new Error("QAdmin credentials are not configured (QADMIN_USERNAME/QADMIN_PASSWORD)");
  }

  const outputPath = path.resolve(process.cwd(), "data", "qadmin.png");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const browser = await launchChromium();
  let stage = "open portal login page";
  let loginAttempted = false;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    page.setDefaultTimeout(30000);

    await page.goto(cfg.qadmin.baseUrl, { waitUntil: "domcontentloaded" });
    const usernameField = page.locator(cfg.qadmin.usernameSelector).first();
    if (await usernameField.isVisible().catch(() => false)) {
      stage = "submit portal login";
      loginAttempted = true;
      await usernameField.fill(cfg.qadmin.username);
      await page.locator(cfg.qadmin.passwordSelector).fill(cfg.qadmin.password);
      await Promise.all([
        usernameField.waitFor({ state: "hidden", timeout: 20000 }),
        page.locator(cfg.qadmin.loginButtonSelector).first().click(),
      ]);
      if (await usernameField.isVisible().catch(() => false)) {
        throw new Error("QAdmin login did not complete; verify portal credentials");
      }
    }

    stage = "navigate to queue page";
    await page.goto(cfg.qadmin.queueUrl, { waitUntil: "commit" });
    const queueSection = page.locator(cfg.qadmin.queueSelector).first();

    stage = "wait for queue section";
    const loginRedirect = usernameField
      .waitFor({ state: "visible", timeout: 5000 })
      .then(() => "login" as const)
      .catch(() => null);
    const queueReady = queueSection
      .waitFor({ state: "visible", timeout: 30000 })
      .then(() => "queue" as const);
    const pageState = await Promise.race([loginRedirect, queueReady]);
    if (pageState === "login") {
      const loginPath = new URL(page.url()).pathname;
      if (!loginAttempted) {
        throw new Error(
          `QAdmin returned a login page instead of the queue page (${loginPath}), but the configured username selector ` +
            `did not match the login form at QADMIN_BASE_URL (${cfg.qadmin.usernameSelector}). ` +
            "No credentials were submitted. Check QADMIN_USERNAME_SELECTOR and QADMIN_PASSWORD_SELECTOR against the production login form."
        );
      }
      throw new Error(
        `QAdmin returned a login page instead of the queue page (${loginPath}) after the login form was submitted. ` +
          "Check that the production app process has the current QADMIN_USERNAME and QADMIN_PASSWORD, " +
          "and confirm this account is permitted to open QADMIN_QUEUE_URL."
      );
    }

    const queueStatus = await queueSection.locator("tbody tr").evaluateAll((rows) =>
      rows
        .map((row) => {
          const cells = Array.from(row.querySelectorAll("td"));
          const operatorLines = (cells[0]?.innerText ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          const messageCount = (cells[1]?.innerText ?? "").match(/\d+/)?.[0];
          return {
            operator: operatorLines.at(-1) ?? "",
            queuedMessages: messageCount === undefined ? Number.NaN : Number(messageCount),
          };
        })
        .filter((row) => row.operator && Number.isFinite(row.queuedMessages))
    );

    if (queueStatus.length === 0) {
      throw new Error("Queue table is visible, but no operator message counts could be read");
    }

    stage = "save queue screenshot";
    await queueSection.screenshot({ path: outputPath, animations: "disabled" });
    console.log(`[QAdmin] Outgoing queue screenshot saved: ${outputPath}`);
    return { screenshotPath: outputPath, queueStatus };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not capture QAdmin outgoing queue while trying to ${stage}: ${message}`);
  } finally {
    await browser.close();
  }
}