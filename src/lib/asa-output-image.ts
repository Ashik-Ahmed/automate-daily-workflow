import { launchChromium } from "./playwright-browser";

export function getReportableAsaOutput(rawOutput: string): string {
  const lines = rawOutput.split(/\r?\n/);
  const firstPeer = lines.findIndex((line) => /^\s*1\s+IKE Peer:/i.test(line));
  return firstPeer >= 0 ? lines.slice(firstPeer).join("\n").trim() : "";
}

export async function renderAsaOutputImage(rawOutput: string): Promise<Buffer> {
  const output = getReportableAsaOutput(rawOutput) || "No IKE Peer output found.";
  const lines = output.split("\n");
  const maxLineLength = Math.max(1, ...lines.map((line) => line.length));
  const width = Math.max(720, Math.min(2400, maxLineLength * 9 + 24));
  const browser = await launchChromium();

  try {
    const page = await browser.newPage({
      viewport: { width, height: Math.max(22, lines.length * 22 + 2) },
      deviceScaleFactor: 1,
    });
    const rows = lines
      .map((line) => `<div class="row">${escapeHtml(line)}</div>`)
      .join("");
    await page.setContent(
      `<html><head><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; background: #fff; }
        .output { width: ${width}px; border: 1px solid #d0d0d0; color: #102a43;
          font: 14px/22px Consolas, "Courier New", monospace; white-space: pre; }
        .row { height: 22px; padding: 0 7px; border-bottom: 1px solid #d0d0d0; }
        .row:last-child { border-bottom: 0; }
      </style></head><body><div class="output">${rows}</div></body></html>`,
      { waitUntil: "load" }
    );

    return await page.screenshot({ type: "png", fullPage: true });
  } finally {
    await browser.close();
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
