import {
  pgTable,
  serial,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Roster / Employee ───────────────────────────────────────────────────────

export const rosterEntries = pgTable("roster_entries", {
  id: serial("id").primaryKey(),
  employeeName: text("employee_name").notNull(),
  shift: text("shift").notNull().default("Day"),
  date: text("date").notNull(), // YYYY-MM-DD
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── Stakeholder / VPN Peers ─────────────────────────────────────────────────

export const stakeholders = pgTable("stakeholders", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  peerIp: text("peer_ip").notNull(),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── App Configuration ────────────────────────────────────────────────────────

export const appConfig = pgTable("app_config", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── Job Runs / Audit Log ────────────────────────────────────────────────────

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  jobType: text("job_type").notNull(), // 'roster' | 'connectivity'
  status: text("status").notNull().default("pending"), // pending | waiting_confirm | confirmed | sending | retrying | rejected | sent | holiday | error | delivery_unknown
  triggerType: text("trigger_type").notNull().default("scheduled"), // scheduled | manual
  scheduledDate: text("scheduled_date"), // YYYY-MM-DD; unique per job type for scheduled runs
  previewData: jsonb("preview_data"),
  telegramMessageId: integer("telegram_message_id"),
  retryCount: integer("retry_count").notNull().default(0),
  workflowStep: text("workflow_step").notNull().default("prepare"), // current resumable workflow stage
  nextAttemptAt: timestamp("next_attempt_at"),
  approvalExpiresAt: timestamp("approval_expires_at"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  deliveryOutcome: text("delivery_outcome"), // accepted | rejected | ambiguous | null
  adjustments: text("adjustments"),
  emailSentAt: timestamp("email_sent_at"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  uniqueIndex("job_runs_scheduled_daily_unique")
    .on(table.jobType, table.scheduledDate),
]);

// ─── Connectivity Results ─────────────────────────────────────────────────────

export const connectivityResults = pgTable("connectivity_results", {
  id: serial("id").primaryKey(),
  checkDate: text("check_date").notNull(), // YYYY-MM-DD
  rawOutput: text("raw_output"),
  parsedData: jsonb("parsed_data"),
  jobRunId: integer("job_run_id").references(() => jobRuns.id),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  uniqueIndex("connectivity_results_job_run_unique").on(table.jobRunId),
]);
