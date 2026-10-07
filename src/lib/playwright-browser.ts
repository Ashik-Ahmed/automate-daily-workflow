import { chromium } from "playwright";

export async function launchChromium() {
  try {
    return await chromium.launch({ headless: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Executable doesn't exist")) {
      throw new Error(
        "Playwright Chromium is not installed for this application user. Run `npm run install:browser` on the production server, then restart the app."
      );
    }
    throw error;
  }
}
