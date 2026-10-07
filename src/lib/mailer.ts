import * as nodemailer from "nodemailer";
import * as path from "node:path";
import { cfg } from "./config";

type Transporter = ReturnType<typeof nodemailer.createTransport>;

let _transporter: Transporter | null = null;

export function getTransporter(): Transporter {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 60_000,
      auth: {
        user: cfg.smtp.user,
        pass: cfg.smtp.pass,
      },
    });
  }
  return _transporter;
}

export interface SendMailOptions {
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  attachments?: EmailAttachment[];
}

interface EmailAttachment {
  filename: string;
  path: string;
  cid?: string;
  contentDisposition?: "inline" | "attachment";
}

export interface EmailDeliveryResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  response: string;
}

function formatRecipient(recipient: unknown): string {
  if (typeof recipient === "string") return recipient;
  if (
    typeof recipient === "object" &&
    recipient !== null &&
    "address" in recipient &&
    typeof recipient.address === "string"
  ) {
    return recipient.address;
  }
  return String(recipient);
}

function fromAddress(from: string): string {
  const bracketedAddress = from.match(/<\s*([^>]+)\s*>/)?.[1];
  return (bracketedAddress ?? from).trim().toLowerCase();
}

function ashikSignatureHtml(): string {
  return `
<div style="margin-top:56px;font-family:Arial,sans-serif;color:#16447b;font-size:14px">
  <p style="margin:0 0 22px">Best Regards</p>
  <p style="margin:0;color:#0074bd;font-size:16px;font-weight:bold">Ashik Ahmed</p>
  <p style="margin:2px 0 20px;color:#17145b;font-family:Georgia,serif;font-size:12px;font-weight:bold">Manager, Technology</p>
  <table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-left:8px">
    <tr>
      <td style="width:178px;height:198px;padding:0 12px 28px 0;border-right:1px solid #222;vertical-align:top;color:#111;font-family:Georgia,serif;font-size:12px;line-height:14px">
        Hosaf High Tower<br>
        9 Mohakhali C/A, 12th Floor,<br>
        Dhaka -1212. Bangladesh.<br><br>
        E: <a href="mailto:ashik@infotelebd.com">ashik@infotelebd.com</a><br>
        M: +880 1999097206<br>
        Tel: +88.02.8833944<br>
        Fax: +88.02.8833943<br>
        <a href="https://www.infotelebd.com">www.infotelebd.com</a>
      </td>
      <td style="padding:0 0 0 10px;vertical-align:top">
        <img src="cid:infozillion-logo" alt="Infozillion Teletech BD" width="180" style="display:block;width:180px;height:auto;border:0">
      </td>
    </tr>
  </table>
  <p style="margin:24px 0 0;color:#111;font-family:Georgia,serif;font-size:12px">----</p>
  <p style="margin:0;color:#f06b22;font-family:Arial,sans-serif;font-size:12px;font-style:italic;line-height:14px">
    This e-mail is confidential. It may also be legally privileged. If you are not the addressee you may not copy, forward, disclose or use any part of it. If you have received this message in error, please delete it and all copies from your system and notify the sender immediately by return e-mail. Internet communications cannot be guaranteed to be timely, secure, error or virus-free. The sender does not accept liability for any errors or omissions.
  </p>
</div>`;
}

function addSenderSignature(html: string): { html: string; logoAttachment?: EmailAttachment } {
  if (fromAddress(cfg.smtp.from) !== "ashik@infotelebd.com") {
    return { html };
  }

  const signature = ashikSignatureHtml();
  const signedHtml = /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${signature}</body>`)
    : `${html}${signature}`;

  return {
    html: signedHtml,
    logoAttachment: {
      filename: "Info-Logo.png",
      path: path.resolve(process.cwd(), "public", "Info-Logo.png"),
      cid: "infozillion-logo",
      contentDisposition: "inline",
    },
  };
}

export async function sendEmail(opts: SendMailOptions): Promise<EmailDeliveryResult> {
  if (opts.to.length === 0) {
    throw new Error("Email was not sent: no To recipients are configured");
  }

  const t = getTransporter();
  const signature = addSenderSignature(opts.html);
  const info = await t.sendMail({
    from: cfg.smtp.from,
    to: opts.to.join(", "),
    cc: opts.cc?.join(", "),
    subject: opts.subject,
    html: signature.html,
    attachments: [
      ...(opts.attachments ?? []),
      ...(signature.logoAttachment ? [signature.logoAttachment] : []),
    ],
  });

  const result = {
    messageId: info.messageId,
    accepted: info.accepted.map(formatRecipient),
    rejected: info.rejected.map(formatRecipient),
    response: info.response,
  };
  if (result.accepted.length === 0) {
    throw new Error(`SMTP accepted no recipients. Rejected: ${result.rejected.join(", ") || "none reported"}`);
  }

  console.info("[Mailer] SMTP accepted message", result);
  return result;
}

export async function verifySmtp(): Promise<boolean> {
  try {
    const t = getTransporter();
    await t.verify();
    return true;
  } catch {
    return false;
  }
}
