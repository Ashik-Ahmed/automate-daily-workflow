// Central config — reads all env vars and provides typed helpers

export const cfg = {
  // Email (SMTP)
  smtp: {
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER ?? "",
    pass: process.env.SMTP_PASS ?? "",
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER ?? "",
  },

  // Recipient addresses (comma-separated in env)
  email: {
    rosterTo: (process.env.ROSTER_EMAIL_TO ?? "").split(",").filter(Boolean),
    rosterCc: (process.env.ROSTER_EMAIL_CC ?? "").split(",").filter(Boolean),
    connectivityTo: (process.env.CONNECTIVITY_EMAIL_TO ?? "").split(",").filter(Boolean),
    connectivityCc: (process.env.CONNECTIVITY_EMAIL_CC ?? "").split(",").filter(Boolean),
  },

  // Telegram
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },

  // ASA Firewall SSH
  asa: {
    host: process.env.ASA_HOST ?? "",
    port: Number(process.env.ASA_PORT ?? 22),
    user: process.env.ASA_USER ?? "",
    pass: process.env.ASA_PASS ?? "",
    enablePass: process.env.ASA_ENABLE_PASS ?? "",
  },

  // QAdmin portal used for the outgoing queue screenshot
  qadmin: {
    baseUrl: process.env.QADMIN_BASE_URL ?? "http://npch.infotelebd.com:8080/QAdmin/",
    queueUrl:
      process.env.QADMIN_QUEUE_URL ??
      "http://npch.infotelebd.com:8080/QAdmin/pages/admin/queueManagement.xhtml",
    username: process.env.QADMIN_USERNAME ?? "",
    password: process.env.QADMIN_PASSWORD ?? "",
    usernameSelector:
      process.env.QADMIN_USERNAME_SELECTOR ?? 'input[name="j_idt141:j_username"]',
    passwordSelector:
      process.env.QADMIN_PASSWORD_SELECTOR ?? 'input[name="j_idt141:j_password"]',
    loginButtonSelector:
      process.env.QADMIN_LOGIN_BUTTON_SELECTOR ??
      'input[type="submit"][value="Login"], button:has-text("Login")',
    queueSelector:
      process.env.QADMIN_QUEUE_SELECTOR ??
      '.ui-datatable:has(.ui-datatable-header:has-text("Queue Management"))',
  },

  // Excel attachment
  excel: {
    filePath: process.env.CONNECTIVITY_EXCEL_PATH ?? "./data/connectivity.xlsx",
    sheetPrefix: process.env.EXCEL_SHEET_PREFIX ?? "Connectivity",
  },

  // Cron schedules (default: 8 AM daily)
  cron: {
    roster: process.env.CRON_ROSTER ?? "0 8 * * *",
    connectivity: process.env.CRON_CONNECTIVITY ?? "0 8 * * *",
  },

  // Confirmation timeout (ms) — default 30 minutes
  confirmTimeout: Number(process.env.CONFIRM_TIMEOUT_MS ?? 1800000),
};
