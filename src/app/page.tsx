"use client";

import { useState, useEffect, useCallback } from "react";
import { ROSTER_SHIFT_OPTIONS } from "@/lib/roster-shifts";

// ─── Types ────────────────────────────────────────────────────────────────────

interface JobRun {
  id: number;
  jobType: string;
  status: string;
  triggerType: string;
  adjustments: string | null;
  emailSentAt: string | null;
  error: string | null;
  createdAt: string;
}

interface RosterEntry {
  id: number;
  employeeName: string;
  shift: string;
  date: string;
  notes: string | null;
}

interface HolidayDate {
  date: string;
  name: string;
}

interface Stakeholder {
  id: number;
  name: string;
  peerIp: string;
  description: string | null;
  active: boolean;
}

interface SystemConfig {
  smtp: { host: string; user: string; ok: boolean };
  telegram: { chatId: string; ok: boolean };
  asa: { host: string; ok: boolean };
  schedule: { start: string; end: string; days: number[]; roster: string; connectivity: string };
  email: { rosterTo: string[]; rosterCc: string[]; connectivityTo: string[]; connectivityCc: string[] };
}

interface EmailRecipientForm {
  rosterTo: string;
  rosterCc: string;
  connectivityTo: string;
  connectivityCc: string;
}

interface ScheduleWindow {
  start: string;
  end: string;
  days: number[];
}

interface SchedulerStatusResponse {
  serverTime: string;
  serverTimeZone: string;
  schedule: ScheduleWindow;
  scheduler: {
    initialized: boolean;
    initializing: boolean;
    lastCheckedAt: string | null;
    lastError: string | null;
    selectedToday: boolean;
    serverMinuteOfDay: number;
    windowStartMinute: number;
    windowEndMinute: number;
    roster: { date: string | null; plannedTime: string | null; dispatched: boolean };
    connectivity: { date: string | null; plannedTime: string | null; dispatched: boolean };
  };
}

const SCHEDULE_DAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

interface ConnectivityResult {
  id: number;
  checkDate: string;
  rawOutput: string | null;
  parsedData: unknown;
  createdAt: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  waiting_confirm: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  waiting_adjustment: "bg-yellow-500/20 text-yellow-300 border-yellow-500/30",
  confirmed: "bg-teal-500/20 text-teal-300 border-teal-500/30",
  sent: "bg-green-500/20 text-green-300 border-green-500/30",
  holiday: "bg-slate-500/20 text-slate-300 border-slate-500/30",
  rejected: "bg-orange-500/20 text-orange-300 border-orange-500/30",
  error: "bg-red-500/20 text-red-300 border-red-500/30",
};

const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  waiting_confirm: "💬",
  waiting_adjustment: "✏️",
  confirmed: "✅",
  sent: "📧",
  holiday: "🏖️",
  rejected: "❌",
  error: "🔥",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border font-medium ${STATUS_COLORS[status] ?? "bg-slate-500/20 text-slate-300 border-slate-500/30"}`}
    >
      {STATUS_ICONS[status] ?? "•"} {status === "sent" ? "SMTP accepted" : status.replace("_", " ")}
    </span>
  );
}

function Card({
  title,
  icon,
  children,
  className = "",
}: {
  title: string;
  icon: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-slate-900 border border-slate-700/50 rounded-2xl overflow-hidden ${className}`}>
      <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-700/50 bg-slate-800/40">
        <span className="text-xl">{icon}</span>
        <h2 className="font-semibold text-slate-100 text-sm uppercase tracking-wider">{title}</h2>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Btn({
  onClick,
  disabled,
  variant = "primary",
  children,
  className = "",
}: {
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "success";
  children: React.ReactNode;
  className?: string;
}) {
  const variants = {
    primary: "bg-blue-600 hover:bg-blue-500 text-white border-blue-500",
    secondary: "bg-slate-700 hover:bg-slate-600 text-slate-200 border-slate-600",
    danger: "bg-red-700 hover:bg-red-600 text-white border-red-600",
    success: "bg-green-700 hover:bg-green-600 text-white border-green-600",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

// ─── Tabs ────────────────────────────────────────────────────────────────────

type Tab = "dashboard" | "roster" | "stakeholders" | "history" | "setup";

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("dashboard");
  const [jobs, setJobs] = useState<JobRun[]>([]);
  const [sysConfig, setSysConfig] = useState<SystemConfig | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: "ok" | "err" } | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleWindow, setScheduleWindow] = useState<ScheduleWindow>({
    start: "08:30",
    end: "08:50",
    days: [0, 1, 2, 3, 4],
  });

  const showToast = (msg: string, type: "ok" | "err" = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const fetchJobs = useCallback(async () => {
    const res = await fetch("/api/jobs/history");
    if (res.ok) setJobs(await res.json() as JobRun[]);
  }, []);

  const fetchConfig = useCallback(async () => {
    const res = await fetch("/api/config");
    if (res.ok) {
      const config = await res.json() as SystemConfig;
      setSysConfig(config);
      setScheduleWindow({
        start: config.schedule.start,
        end: config.schedule.end,
        days: config.schedule.days,
      });
    }
  }, []);

  const saveEmailRecipients = async (email: EmailRecipientForm) => {
    setSavingRecipients(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save email recipients");
      await fetchConfig();
      showToast("Email recipients saved");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setSavingRecipients(false);
    }
  };

  const saveSchedule = async (schedule: ScheduleWindow) => {
    setSavingSchedule(true);
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not save schedule");
      await fetchConfig();
      showToast("Automatic job schedule saved");
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : String(err), "err");
    } finally {
      setSavingSchedule(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    fetchConfig();
    const interval = setInterval(fetchJobs, 15000);
    return () => clearInterval(interval);
  }, [fetchJobs, fetchConfig]);

  const triggerJob = async (type: "roster" | "connectivity") => {
    setTriggering(type);
    try {
      const res = await fetch("/api/jobs/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const data = await res.json() as { message?: string; error?: string };
      if (res.ok) {
        showToast(data.message ?? "Job triggered!", "ok");
        setTimeout(fetchJobs, 2000);
      } else {
        showToast(data.error ?? "Failed", "err");
      }
    } catch {
      showToast("Network error", "err");
    } finally {
      setTriggering(null);
    }
  };

  const recentJobs = jobs.slice(0, 5);
  const sentToday = jobs.filter(
    (j) => j.status === "sent" && j.emailSentAt?.startsWith(new Date().toISOString().slice(0, 10))
  ).length;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header
        className="relative border-b border-slate-700/50 overflow-hidden"
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #0f172a 100%)",
        }}
      >
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: "url(/hero-bg.jpg)",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-blue-600 flex items-center justify-center text-2xl shadow-lg shadow-blue-500/30">
              🤖
            </div>
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight">TeamOps Automation</h1>
              <p className="text-slate-400 text-xs mt-0.5">
                Daily Roster &amp; Connectivity Email Automation
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {sysConfig && (
              <div className="flex gap-2">
                <span className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border ${sysConfig.smtp.ok ? "bg-green-500/10 text-green-400 border-green-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"}`}>
                  📧 SMTP {sysConfig.smtp.ok ? "✓" : "✗"}
                </span>
                <span className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border ${sysConfig.telegram.ok ? "bg-green-500/10 text-green-400 border-green-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"}`}>
                  💬 Telegram {sysConfig.telegram.ok ? "✓" : "✗"}
                </span>
                <span className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border ${sysConfig.asa.ok ? "bg-green-500/10 text-green-400 border-green-500/30" : "bg-red-500/10 text-red-400 border-red-500/30"}`}>
                  🔥 ASA {sysConfig.asa.ok ? "✓" : "✗"}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Tab nav */}
        <div className="relative max-w-7xl mx-auto px-6">
          <nav className="flex gap-1">
            {(
              [
                { id: "dashboard", label: "Dashboard", icon: "📊" },
                { id: "roster", label: "Roster Manager", icon: "📋" },
                { id: "stakeholders", label: "Stakeholders", icon: "🔗" },
                { id: "history", label: "Job History", icon: "📜" },
                { id: "setup", label: "Setup Guide", icon: "⚙️" },
              ] as { id: Tab; label: string; icon: string }[]
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium transition-all border-b-2 ${
                  activeTab === tab.id
                    ? "border-blue-500 text-blue-400"
                    : "border-transparent text-slate-400 hover:text-slate-200"
                }`}
              >
                {tab.icon} {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 px-5 py-3 rounded-xl shadow-xl border text-sm font-medium transition-all ${
            toast.type === "ok"
              ? "bg-green-900/90 border-green-500/50 text-green-100"
              : "bg-red-900/90 border-red-500/50 text-red-100"
          }`}
        >
          {toast.type === "ok" ? "✅" : "❌"} {toast.msg}
        </div>
      )}

      {/* Content */}
      <main className="flex-1 max-w-7xl mx-auto px-6 py-8 w-full">
        {activeTab === "dashboard" && (
          <DashboardTab
            jobs={jobs}
            recentJobs={recentJobs}
            sentToday={sentToday}
            sysConfig={sysConfig}
            triggering={triggering}
            onTrigger={triggerJob}
            onRefresh={fetchJobs}
          />
        )}
        {activeTab === "roster" && <RosterTab showToast={showToast} />}
        {activeTab === "stakeholders" && <StakeholdersTab showToast={showToast} />}
        {activeTab === "history" && <HistoryTab jobs={jobs} onRefresh={fetchJobs} />}
        {activeTab === "setup" && (
          <SetupTab
            sysConfig={sysConfig}
            savingRecipients={savingRecipients}
            onSaveRecipients={saveEmailRecipients}
            scheduleWindow={scheduleWindow}
            setScheduleWindow={setScheduleWindow}
            savingSchedule={savingSchedule}
            onSaveSchedule={saveSchedule}
          />
        )}
      </main>

      <footer className="border-t border-slate-800 px-6 py-4 text-center text-slate-500 text-xs">
        TeamOps Automation — Technology Team Manager Dashboard
      </footer>
    </div>
  );
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashboardTab({
  jobs,
  recentJobs,
  sentToday,
  sysConfig,
  triggering,
  onTrigger,
  onRefresh,
}: {
  jobs: JobRun[];
  recentJobs: JobRun[];
  sentToday: number;
  sysConfig: SystemConfig | null;
  triggering: string | null;
  onTrigger: (type: "roster" | "connectivity") => void;
  onRefresh: () => void;
}) {
  const totalSent = jobs.filter((j) => j.status === "sent").length;
  const totalErrors = jobs.filter((j) => j.status === "error").length;
  const awaitingConfirm = jobs.filter(
    (j) => j.status === "waiting_confirm" || j.status === "waiting_adjustment"
  ).length;

  return (
    <div className="space-y-6">
      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: "SMTP Accepted Today", value: sentToday, icon: "📧", color: "blue" },
          { label: "Total SMTP Accepted", value: totalSent, icon: "✅", color: "green" },
          { label: "Awaiting Confirmation", value: awaitingConfirm, icon: "💬", color: "yellow" },
          { label: "Errors", value: totalErrors, icon: "🔥", color: "red" },
        ].map((stat) => (
          <div
            key={stat.label}
            className="bg-slate-900 border border-slate-700/50 rounded-2xl p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-2xl">{stat.icon}</span>
              <span
                className={`text-3xl font-bold ${
                  stat.color === "blue"
                    ? "text-blue-400"
                    : stat.color === "green"
                    ? "text-green-400"
                    : stat.color === "yellow"
                    ? "text-yellow-400"
                    : "text-red-400"
                }`}
              >
                {stat.value}
              </span>
            </div>
            <p className="text-slate-400 text-sm">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* Action Cards */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Roster Job */}
        <div className="bg-gradient-to-br from-blue-900/40 to-slate-900 border border-blue-500/20 rounded-2xl p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-3xl">📋</span>
                <h3 className="text-lg font-bold text-white">Daily Roster Email</h3>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                Sends today&apos;s staff roster to management. Pulls from uploaded roster file.
                Telegram confirmation required before sending.
              </p>
            </div>
          </div>
          <div className="bg-slate-800/60 rounded-xl p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Schedule</span>
              <span className="text-slate-200 font-mono">{sysConfig?.schedule.roster ?? "–"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Recipients</span>
              <span className="text-slate-200 text-xs">{sysConfig?.email.rosterTo.length ?? 0} configured</span>
            </div>
          </div>
          <Btn
            onClick={() => onTrigger("roster")}
            disabled={triggering === "roster"}
            variant="primary"
            className="w-full justify-center"
          >
            {triggering === "roster" ? "⏳ Triggering…" : "▶ Trigger Roster Job Now"}
          </Btn>
        </div>

        {/* Connectivity Job */}
        <div className="bg-gradient-to-br from-teal-900/40 to-slate-900 border border-teal-500/20 rounded-2xl p-6">
          <div className="flex items-start justify-between mb-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="text-3xl">🔗</span>
                <h3 className="text-lg font-bold text-white">Connectivity Email</h3>
              </div>
              <p className="text-slate-400 text-sm leading-relaxed">
                SSH into ASA Firewall, run{" "}
                <code className="bg-slate-700 px-1 rounded text-xs">sh crypto isakmp sa</code>,
                save to Excel &amp; email management.
              </p>
            </div>
          </div>
          <div className="bg-slate-800/60 rounded-xl p-4 mb-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-400">Schedule</span>
              <span className="text-slate-200 font-mono">{sysConfig?.schedule.connectivity ?? "–"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">ASA Host</span>
              <span className="text-slate-200 text-xs font-mono">{sysConfig?.asa.host ?? "(not set)"}</span>
            </div>
          </div>
          <Btn
            onClick={() => onTrigger("connectivity")}
            disabled={triggering === "connectivity"}
            variant="success"
            className="w-full justify-center"
          >
            {triggering === "connectivity" ? "⏳ Triggering…" : "▶ Trigger Connectivity Job Now"}
          </Btn>
        </div>
      </div>

      {/* Workflow diagram */}
      <Card title="How It Works" icon="📐">
        <div className="grid md:grid-cols-2 gap-8">
          <div>
            <h4 className="text-blue-400 font-semibold mb-4 flex items-center gap-2">
              <span className="w-6 h-6 bg-blue-600 rounded-full text-xs flex items-center justify-center">1</span>
              Roster Email Flow
            </h4>
            <div className="space-y-2">
              {[
                "⏰ Cron triggers at scheduled time (or manual)",
                "📂 Pulls today's roster from uploaded file/DB",
                "💬 Sends preview to your Telegram",
                "👆 You approve / request changes / cancel",
                "✏️ Type changes in chat → auto-adjusted",
                "📧 Email sent to management!",
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <span className="text-slate-500 mt-0.5 min-w-[20px]">{i + 1}.</span>
                  <span className="text-slate-300">{step}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h4 className="text-teal-400 font-semibold mb-4 flex items-center gap-2">
              <span className="w-6 h-6 bg-teal-600 rounded-full text-xs flex items-center justify-center">2</span>
              Connectivity Email Flow
            </h4>
            <div className="space-y-2">
              {[
                "⏰ Cron triggers at scheduled time (or manual)",
                "🔒 SSH into ASA Firewall",
                "📟 Runs 'show crypto isakmp sa'",
                "📊 Parses output, adds to Excel new sheet",
                "💬 Shows output preview in Telegram",
                "👆 You confirm → Excel attached + email sent!",
              ].map((step, i) => (
                <div key={i} className="flex items-start gap-3 text-sm">
                  <span className="text-slate-500 mt-0.5 min-w-[20px]">{i + 1}.</span>
                  <span className="text-slate-300">{step}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Recent Jobs */}
      <Card title="Recent Jobs" icon="📜">
        <div className="flex justify-end mb-3">
          <Btn onClick={onRefresh} variant="secondary">🔄 Refresh</Btn>
        </div>
        {recentJobs.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">
            No jobs yet. Trigger one above or wait for the scheduled run.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs uppercase border-b border-slate-700/50">
                  <th className="text-left pb-3">ID</th>
                  <th className="text-left pb-3">Type</th>
                  <th className="text-left pb-3">Status</th>
                  <th className="text-left pb-3">Trigger</th>
                  <th className="text-left pb-3">Started</th>
                  <th className="text-left pb-3">Adjustments</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {recentJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-800/30 transition-colors">
                    <td className="py-3 text-slate-400 font-mono">#{job.id}</td>
                    <td className="py-3">
                      <span className={`font-medium ${job.jobType === "roster" ? "text-blue-400" : "text-teal-400"}`}>
                        {job.jobType === "roster" ? "📋 Roster" : "🔗 Connectivity"}
                      </span>
                    </td>
                    <td className="py-3">
                      <StatusBadge status={job.status} />
                    </td>
                    <td className="py-3 text-slate-400 capitalize">{job.triggerType}</td>
                    <td className="py-3 text-slate-400 text-xs">
                      {new Date(job.createdAt).toLocaleString()}
                    </td>
                    <td className="py-3 text-slate-400 text-xs max-w-[200px] truncate">
                      {job.adjustments ?? "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Roster Tab ───────────────────────────────────────────────────────────────

function RosterTab({ showToast }: { showToast: (msg: string, type: "ok" | "err") => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [entries, setEntries] = useState<RosterEntry[]>([]);
  const [holidays, setHolidays] = useState<HolidayDate[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [holidayDate, setHolidayDate] = useState(new Date().toISOString().slice(0, 10));
  const [holidayName, setHolidayName] = useState("");
  const [holidayUploading, setHolidayUploading] = useState(false);
  const [newName, setNewName] = useState("");
  const [newShift, setNewShift] = useState<string>(ROSTER_SHIFT_OPTIONS[0]);
  const [newNotes, setNewNotes] = useState("");

  const fetchHolidays = useCallback(async () => {
    const res = await fetch("/api/roster/holidays");
    if (res.ok) setHolidays(await res.json() as HolidayDate[]);
  }, []);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/roster?date=${date}`);
    if (res.ok) setEntries(await res.json() as RosterEntry[]);
    await fetchHolidays();
    setLoading(false);
  }, [date, fetchHolidays]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const addHoliday = async () => {
    const res = await fetch("/api/roster/holidays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: holidayDate, name: holidayName || "Holiday" }),
    });
    const data = await res.json() as { error?: string };
    if (!res.ok) return showToast(data.error ?? "Could not add holiday", "err");
    showToast("Holiday date saved", "ok");
    setHolidayName("");
    fetchEntries();
  };

  const uploadHolidayCalendar = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setHolidayUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch("/api/roster/holidays/upload", { method: "POST", body: formData });
    const data = await res.json() as { ok?: boolean; count?: number; error?: string };
    if (res.ok) {
      showToast(`Imported ${data.count ?? 0} holiday dates`, "ok");
      fetchEntries();
    } else {
      showToast(data.error ?? "Holiday calendar upload failed", "err");
    }
    setHolidayUploading(false);
    event.target.value = "";
  };

  const removeHoliday = async (holiday: HolidayDate) => {
    const res = await fetch(`/api/roster/holidays?date=${holiday.date}`, { method: "DELETE" });
    if (res.ok) {
      showToast("Holiday date removed", "ok");
      fetchEntries();
    } else showToast("Could not remove holiday", "err");
  };

  const selectedHoliday = holidays.find((holiday) => holiday.date === date);

  const addEntry = async () => {
    if (!newName.trim()) return showToast("Enter employee name", "err");
    const res = await fetch("/api/roster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ employeeName: newName, shift: newShift, date, notes: newNotes }),
    });
    if (res.ok) {
      showToast("Entry added", "ok");
      setNewName(""); setNewShift(ROSTER_SHIFT_OPTIONS[0]); setNewNotes("");
      fetchEntries();
    } else showToast("Failed to add", "err");
  };

  const deleteEntry = async (id: number) => {
    const res = await fetch(`/api/roster?id=${id}`, { method: "DELETE" });
    if (res.ok) { showToast("Removed", "ok"); fetchEntries(); }
    else showToast("Failed to remove", "err");
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/roster/upload", { method: "POST", body: fd });
    const data = await res.json() as { ok: boolean; count?: number; error?: string; dates?: string[] };
    if (data.ok) {
      showToast(`Uploaded ${data.count} entries for dates: ${data.dates?.join(", ")}`, "ok");
      fetchEntries();
    } else showToast(data.error ?? "Upload failed", "err");
    setUploading(false);
    e.target.value = "";
  };

  const shifts = [...new Set(entries.map((e) => e.shift))].sort();

  return (
    <div className="space-y-6">
      {/* Upload */}
      <Card title="Upload Monthly Roster" icon="📤">
        <div className="flex flex-col md:flex-row gap-6 items-start">
          <div className="flex-1">
            <p className="text-slate-400 text-sm mb-4">
              Upload the monthly roster as an <strong className="text-slate-200">Excel (.xlsx)</strong> workbook.
              CSV and JSON uploads are also supported.
              The system will automatically pull today&apos;s entries when the job runs.
            </p>
            <div className="bg-slate-800/50 border border-slate-600/50 rounded-xl p-4 text-sm space-y-2 mb-4">
              <p className="text-slate-300 font-semibold">Excel columns:</p>
              <p className="text-slate-400 text-xs">Date, Daytime (Office), Daytime (Home/Office), Evening (Home), Morning Report</p>
              <p className="text-slate-300 font-semibold mt-3">CSV format:</p>
              <pre className="text-slate-400 text-xs bg-slate-900/80 rounded-lg p-3 overflow-x-auto">
{`name,shift,date,notes
Mr. Obaydul,Daytime (Office),2024-01-15,
Mr. Shawon,Daytime (Home/Office),2024-01-15,
Mr. Tawfiq,Evening (Home),2024-01-15,
Mr. Ashik,Morning Report,2024-01-15,
Holiday,Holiday,2024-01-16,`}
              </pre>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer bg-blue-700 hover:bg-blue-600 transition-colors text-white px-5 py-2.5 rounded-lg text-sm font-medium">
              {uploading ? "⏳ Uploading…" : "📂 Choose Roster File"}
              <input type="file" accept=".xlsx,.csv,.json" onChange={handleUpload} className="hidden" />
            </label>
          </div>
          <div className="bg-slate-800/60 rounded-xl p-4 text-sm space-y-3 min-w-[240px]">
            <p className="text-slate-300 font-semibold">📊 Current Stats</p>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-400">Viewing Date</span>
                <span className="text-slate-200 font-mono text-xs">{date}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Entries</span>
                <span className="text-blue-400 font-bold">{entries.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Shifts</span>
                <span className="text-slate-200">{shifts.join(", ") || "–"}</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Holiday Calendar" icon="🏖️">
        <div className="flex flex-col lg:flex-row lg:items-end gap-3">
          <label className="space-y-1 text-sm text-slate-300">
            <span>Holiday date</span>
            <input type="date" value={holidayDate} onChange={(event) => setHolidayDate(event.target.value)} className="block bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-3 py-2" />
          </label>
          <label className="flex-1 space-y-1 text-sm text-slate-300">
            <span>Holiday name</span>
            <input value={holidayName} onChange={(event) => setHolidayName(event.target.value)} placeholder="Holiday name (optional)" className="block w-full bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-3 py-2" />
          </label>
          <Btn onClick={addHoliday} variant="primary">Add Holiday Date</Btn>
          <label className="inline-flex items-center justify-center cursor-pointer bg-slate-700 hover:bg-slate-600 text-slate-100 px-4 py-2 rounded-lg text-sm">
            {holidayUploading ? "Uploading…" : "Upload Excel Calendar"}
            <input type="file" accept=".xlsx" onChange={uploadHolidayCalendar} className="hidden" />
          </label>
        </div>
        <p className="text-xs text-slate-500 mt-3">Excel calendar format: a first-row Date column, with an optional Holiday, Name, Event, or Description column. Holiday dates remain separate from employee roster entries.</p>
        {holidays.length > 0 && (
          <div className="mt-5 overflow-x-auto border border-slate-700/50 rounded-lg">
            <table className="w-full text-sm">
              <thead><tr className="bg-slate-800 text-slate-300"><th className="text-left px-3 py-2">Date</th><th className="text-left px-3 py-2">Holiday</th><th className="text-right px-3 py-2">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-700/50">
                {holidays.map((holiday) => (
                  <tr key={holiday.date}>
                    <td className="px-3 py-2 font-mono">{holiday.date}</td>
                    <td className="px-3 py-2">{holiday.name}</td>
                    <td className="px-3 py-2 text-right"><button onClick={() => removeHoliday(holiday)} className="text-red-400 hover:text-red-300">Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Date picker + entries */}
      <Card title="Roster Entries" icon="📋">
        <div className="flex flex-col sm:flex-row gap-3 mb-5">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="bg-slate-800 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm"
          />
          <Btn onClick={fetchEntries} variant="secondary">🔄 Load</Btn>
        </div>

        {/* Add form */}
        {!selectedHoliday && <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6 p-4 bg-slate-800/40 rounded-xl border border-slate-700/30">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Employee name"
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm col-span-2"
          />
          <select
            value={newShift}
            onChange={(e) => setNewShift(e.target.value)}
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            {ROSTER_SHIFT_OPTIONS.map((shift) => (
              <option key={shift} value={shift}>{shift}</option>
            ))}
          </select>
          <input
            value={newNotes}
            onChange={(e) => setNewNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm"
          />
          <Btn onClick={addEntry} variant="primary" className="col-span-2 md:col-span-4">
            ➕ Add Entry for {date}
          </Btn>
        </div>}

        {selectedHoliday ? (
          <div className="text-center py-8 border border-amber-500/30 bg-amber-900/10 rounded-lg">
            <p className="font-semibold text-amber-300">Holiday — no roster available</p>
            <p className="text-sm text-slate-300 mt-1">{selectedHoliday.name} · {selectedHoliday.date}</p>
          </div>
        ) : loading ? (
          <p className="text-slate-500 text-center py-8">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-slate-500 text-center py-8">
            No roster entries for {date}. Upload an Excel workbook or add manually above.
          </p>
        ) : (
          <div className="space-y-4">
            {shifts.map((shift) => (
              <div key={shift}>
                <h4 className="text-slate-300 font-semibold mb-2 flex items-center gap-2">
                  <span className="w-2 h-2 bg-blue-500 rounded-full" />
                  {shift} Shift ({entries.filter((e) => e.shift === shift).length} staff)
                </h4>
                <div className="overflow-x-auto rounded-xl border border-slate-700/50">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400 text-xs uppercase">
                        <th className="text-left px-4 py-3">#</th>
                        <th className="text-left px-4 py-3">Name</th>
                        <th className="text-left px-4 py-3">Shift</th>
                        <th className="text-left px-4 py-3">Notes</th>
                        <th className="text-right px-4 py-3">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/30">
                      {entries
                        .filter((e) => e.shift === shift)
                        .map((entry, i) => (
                          <tr key={entry.id} className="hover:bg-slate-800/30">
                            <td className="px-4 py-3 text-slate-500">{i + 1}</td>
                            <td className="px-4 py-3 font-medium text-slate-200">{entry.employeeName}</td>
                            <td className="px-4 py-3 text-slate-400">{entry.shift}</td>
                            <td className="px-4 py-3 text-slate-500">{entry.notes ?? "–"}</td>
                            <td className="px-4 py-3 text-right">
                              <button
                                onClick={() => deleteEntry(entry.id)}
                                className="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded border border-red-500/30 hover:border-red-400/50 transition-colors"
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Stakeholders Tab ─────────────────────────────────────────────────────────

function StakeholdersTab({ showToast }: { showToast: (msg: string, type: "ok" | "err") => void }) {
  const [stakeholders, setStakeholders] = useState<Stakeholder[]>([]);
  const [newName, setNewName] = useState("");
  const [newIp, setNewIp] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [history, setHistory] = useState<ConnectivityResult[]>([]);

  const fetchAll = useCallback(async () => {
    const [sRes, hRes] = await Promise.all([
      fetch("/api/stakeholders"),
      fetch("/api/connectivity/history"),
    ]);
    if (sRes.ok) setStakeholders(await sRes.json() as Stakeholder[]);
    if (hRes.ok) setHistory(await hRes.json() as ConnectivityResult[]);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const addStakeholder = async () => {
    if (!newName.trim() || !newIp.trim()) return showToast("Name and IP required", "err");
    const res = await fetch("/api/stakeholders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName, peerIp: newIp, description: newDesc }),
    });
    if (res.ok) {
      showToast("Stakeholder added", "ok");
      setNewName(""); setNewIp(""); setNewDesc("");
      fetchAll();
    } else showToast("Failed", "err");
  };

  const deleteStakeholder = async (id: number) => {
    await fetch(`/api/stakeholders?id=${id}`, { method: "DELETE" });
    showToast("Removed", "ok");
    fetchAll();
  };

  return (
    <div className="space-y-6">
      <Card title="Stakeholder VPN Peers" icon="🔗">
        <p className="text-slate-400 text-sm mb-5">
          These are the IPSec peer IPs that are checked daily. They&apos;re used as a reference list
          for the connectivity report. The actual tunnel status comes from the ASA{" "}
          <code className="bg-slate-700 px-1 rounded text-xs">show crypto isakmp sa</code> command.
        </p>

        <div className="grid md:grid-cols-3 gap-3 mb-5 p-4 bg-slate-800/40 rounded-xl border border-slate-700/30">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Stakeholder name"
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm"
          />
          <input
            value={newIp}
            onChange={(e) => setNewIp(e.target.value)}
            placeholder="Peer IP (e.g. 203.0.113.5)"
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="Description (optional)"
            className="bg-slate-700 border border-slate-600 text-slate-200 rounded-lg px-3 py-2 text-sm"
          />
          <Btn onClick={addStakeholder} variant="primary" className="md:col-span-3">
            ➕ Add Stakeholder
          </Btn>
        </div>

        {stakeholders.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">No stakeholders yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-700/50">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800/60 text-slate-400 text-xs uppercase">
                  <th className="text-left px-4 py-3">Name</th>
                  <th className="text-left px-4 py-3">Peer IP</th>
                  <th className="text-left px-4 py-3">Description</th>
                  <th className="text-right px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/30">
                {stakeholders.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-3 font-medium text-slate-200">{s.name}</td>
                    <td className="px-4 py-3 text-teal-400 font-mono">{s.peerIp}</td>
                    <td className="px-4 py-3 text-slate-400">{s.description ?? "–"}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => deleteStakeholder(s.id)}
                        className="text-red-400 hover:text-red-300 text-xs px-2 py-1 rounded border border-red-500/30"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Recent Connectivity Checks" icon="📊">
        {history.length === 0 ? (
          <p className="text-slate-500 text-sm text-center py-8">No connectivity checks yet.</p>
        ) : (
          <div className="space-y-3">
            {history.slice(0, 5).map((h) => {
              const parsed = (h.parsedData as { peerIp: string; state: string; status: string }[] | null) ?? [];
              const up = parsed.filter((e) => e.status === "UP").length;
              const down = parsed.filter((e) => e.status === "DOWN").length;
              return (
                <div key={h.id} className="bg-slate-800/60 rounded-xl p-4 border border-slate-700/30">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-semibold text-slate-200">{h.checkDate}</span>
                    <div className="flex gap-3 text-sm">
                      <span className="text-green-400">✅ {up} UP</span>
                      <span className="text-red-400">❌ {down} DOWN</span>
                    </div>
                  </div>
                  {h.rawOutput && (
                    <pre className="bg-slate-900 rounded-lg p-3 text-xs text-slate-400 overflow-x-auto max-h-32">
                      {h.rawOutput.slice(0, 600)}{h.rawOutput.length > 600 ? "…" : ""}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({ jobs, onRefresh }: { jobs: JobRun[]; onRefresh: () => void }) {
  const [filter, setFilter] = useState<string>("all");

  const filtered = filter === "all" ? jobs : jobs.filter((j) => j.jobType === filter || j.status === filter);

  return (
    <Card title="Job History" icon="📜">
      <div className="flex flex-wrap gap-2 mb-5">
        {["all", "roster", "connectivity", "sent", "holiday", "error", "rejected"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors capitalize ${
              filter === f
                ? "bg-blue-600 border-blue-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200"
            }`}
          >
            {f === "all" ? "All Jobs" : f.replace("_", " ")}
          </button>
        ))}
        <button
          onClick={onRefresh}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-medium border bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200"
        >
          🔄 Refresh
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="text-slate-500 text-center py-12">No jobs match this filter.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-xs uppercase border-b border-slate-700/50">
                <th className="text-left pb-3 pr-4">ID</th>
                <th className="text-left pb-3 pr-4">Type</th>
                <th className="text-left pb-3 pr-4">Status</th>
                <th className="text-left pb-3 pr-4">Trigger</th>
                <th className="text-left pb-3 pr-4">Started</th>
                <th className="text-left pb-3 pr-4">Email Sent</th>
                <th className="text-left pb-3">Error / Adjustments</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/30">
              {filtered.map((job) => (
                <tr key={job.id} className="hover:bg-slate-800/30 transition-colors">
                  <td className="py-3 pr-4 text-slate-400 font-mono">#{job.id}</td>
                  <td className="py-3 pr-4">
                    <span className={`font-medium ${job.jobType === "roster" ? "text-blue-400" : "text-teal-400"}`}>
                      {job.jobType === "roster" ? "📋 Roster" : "🔗 Connectivity"}
                    </span>
                  </td>
                  <td className="py-3 pr-4">
                    <StatusBadge status={job.status} />
                  </td>
                  <td className="py-3 pr-4 text-slate-400 capitalize text-xs">{job.triggerType}</td>
                  <td className="py-3 pr-4 text-slate-400 text-xs whitespace-nowrap">
                    {new Date(job.createdAt).toLocaleString()}
                  </td>
                  <td className="py-3 pr-4 text-slate-400 text-xs whitespace-nowrap">
                    {job.emailSentAt ? new Date(job.emailSentAt).toLocaleString() : "–"}
                  </td>
                  <td className="py-3 text-xs text-slate-500 max-w-[250px] truncate">
                    {job.error ? (
                      <span className="text-red-400">{job.error}</span>
                    ) : job.adjustments ? (
                      <span className="text-yellow-400">{job.adjustments}</span>
                    ) : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ─── Setup Tab ────────────────────────────────────────────────────────────────

function ServerScheduleClock() {
  const [clock, setClock] = useState<{
    status: SchedulerStatusResponse;
    offsetMs: number;
  } | null>(null);
  const [now, setNow] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const response = await fetch("/api/schedule/status", { cache: "no-store" });
        const data = await response.json() as SchedulerStatusResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? "Could not read server schedule status");
        if (active) {
          const receivedAt = Date.now();
          setNow(receivedAt);
          setClock({
            status: data,
            offsetMs: receivedAt - Date.parse(data.serverTime),
          });
          setError(null);
        }
      } catch (err: unknown) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    };

    void refresh();
    const refreshInterval = setInterval(() => void refresh(), 10000);
    const clockInterval = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      clearInterval(refreshInterval);
      clearInterval(clockInterval);
    };
  }, []);

  const formatTime = (value: Date, timeZone?: string) =>
    new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
      ...(timeZone ? { timeZone } : {}),
    }).format(value);

  const serverNow = clock
    ? new Date(now - clock.offsetMs)
    : undefined;
  const clockDifferenceSeconds = clock
    ? Math.round(-clock.offsetMs / 1000)
    : undefined;
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const scheduleRun = (job: SchedulerStatusResponse["scheduler"]["roster"]) => {
    if (job.dispatched) return "Dispatched";
    if (job.plannedTime) return `Planned today at ${job.plannedTime}`;
    if (!clock?.status.scheduler.selectedToday) return "Not scheduled today";
    if (clock.status.scheduler.serverMinuteOfDay < clock.status.scheduler.windowStartMinute) {
      return `Waiting for ${clock.status.schedule.start}`;
    }
    if (clock.status.scheduler.serverMinuteOfDay > clock.status.scheduler.windowEndMinute) {
      return "Today's schedule window has passed";
    }
    return "Waiting for scheduler check";
  };
  const differenceSeconds = clockDifferenceSeconds ?? 0;

  return (
    <div className="mb-5 rounded-xl border border-slate-700 bg-slate-800/50 p-4 text-sm">
      <p className="mb-2 font-semibold text-slate-200">Server clock and scheduler</p>
      {error ? (
        <p className="text-red-300">Unable to read server clock: {error}</p>
      ) : !clock || !serverNow ? (
        <p className="text-slate-400">Reading server clock…</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <p className="text-slate-300">
              Server: <span className="font-medium text-white">{formatTime(serverNow, clock.status.serverTimeZone)}</span>
              <span className="mt-1 block text-xs text-slate-500">{clock.status.serverTimeZone}</span>
            </p>
            <p className="text-slate-300">
              This browser: <span className="font-medium text-white">{formatTime(new Date(now))}</span>
              <span className="mt-1 block text-xs text-slate-500">{browserTimeZone}</span>
            </p>
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Clock difference (server vs browser):{" "}
            <span className={Math.abs(differenceSeconds) > 60 ? "text-amber-300" : "text-green-300"}>
              {Math.abs(differenceSeconds) <= 60
                ? "within 1 minute"
                : `${differenceSeconds > 0 ? "+" : "−"}${Math.floor(Math.abs(differenceSeconds) / 60)}m ${Math.abs(differenceSeconds) % 60}s`}
            </span>
          </p>
          <div className="mt-3 grid gap-2 border-t border-slate-700 pt-3 sm:grid-cols-2">
            <p className="text-xs text-slate-400">Roster: {scheduleRun(clock.status.scheduler.roster)}</p>
            <p className="text-xs text-slate-400">Connectivity: {scheduleRun(clock.status.scheduler.connectivity)}</p>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {clock.status.scheduler.lastError
              ? `Scheduler error: ${clock.status.scheduler.lastError}`
              : clock.status.scheduler.initializing
              ? "Scheduler is initializing."
              : !clock.status.scheduler.initialized
              ? "Scheduler has not initialized in this server process."
              : clock.status.scheduler.lastCheckedAt
              ? `Last checked: ${formatTime(new Date(clock.status.scheduler.lastCheckedAt), clock.status.serverTimeZone)}`
              : "Scheduler is initialized; waiting for its first schedule check."}
          </p>
        </>
      )}
    </div>
  );
}

function SetupTab({
  sysConfig,
  savingRecipients,
  onSaveRecipients,
  scheduleWindow,
  setScheduleWindow,
  savingSchedule,
  onSaveSchedule,
}: {
  sysConfig: SystemConfig | null;
  savingRecipients: boolean;
  onSaveRecipients: (email: EmailRecipientForm) => void;
  scheduleWindow: ScheduleWindow;
  setScheduleWindow: (schedule: ScheduleWindow) => void;
  savingSchedule: boolean;
  onSaveSchedule: (schedule: ScheduleWindow) => void;
}) {
  const [email, setEmail] = useState<EmailRecipientForm>({
    rosterTo: "",
    rosterCc: "",
    connectivityTo: "",
    connectivityCc: "",
  });

  useEffect(() => {
    if (!sysConfig) return;
    setEmail({
      rosterTo: sysConfig.email.rosterTo.join(", "),
      rosterCc: sysConfig.email.rosterCc.join(", "),
      connectivityTo: sysConfig.email.connectivityTo.join(", "),
      connectivityCc: sysConfig.email.connectivityCc.join(", "),
    });
  }, [sysConfig]);

  return (
    <div className="space-y-6">
      <Card title="Email Recipients" icon="📧">
        <p className="text-slate-400 text-sm mb-5">
          Separate multiple addresses with commas. Saved recipients override the email recipient values in the environment file.
        </p>
        <div className="grid md:grid-cols-2 gap-5">
          <RecipientField label="Roster To" value={email.rosterTo} onChange={(value) => setEmail({ ...email, rosterTo: value })} />
          <RecipientField label="Roster CC" value={email.rosterCc} onChange={(value) => setEmail({ ...email, rosterCc: value })} />
          <RecipientField label="Connectivity To" value={email.connectivityTo} onChange={(value) => setEmail({ ...email, connectivityTo: value })} />
          <RecipientField label="Connectivity CC" value={email.connectivityCc} onChange={(value) => setEmail({ ...email, connectivityCc: value })} />
        </div>
        <div className="mt-5 flex justify-end">
          <button onClick={() => onSaveRecipients(email)} disabled={savingRecipients || !sysConfig}>
            {savingRecipients ? "Saving…" : "Save Recipients"}
          </button>
        </div>
      </Card>

      <Card title="Automatic Job Schedule" icon="⏰">
        <p className="mb-4 text-sm text-slate-400">
          Both jobs run at independently randomized times inside this window on the selected days, using server local time. Holiday-calendar dates are skipped.
        </p>
        <ServerScheduleClock />
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <label className="text-sm text-slate-300">
            Window starts
            <input
              type="time"
              value={scheduleWindow.start}
              onChange={(event) => setScheduleWindow({ ...scheduleWindow, start: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white"
            />
          </label>
          <label className="text-sm text-slate-300">
            Window ends
            <input
              type="time"
              value={scheduleWindow.end}
              onChange={(event) => setScheduleWindow({ ...scheduleWindow, end: event.target.value })}
              className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-white"
            />
          </label>
        </div>
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-300">Run on</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SCHEDULE_DAYS.map(({ value, label }) => (
              <label key={value} className="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={scheduleWindow.days.includes(value)}
                  onChange={(event) => {
                    const days = event.target.checked
                      ? [...scheduleWindow.days, value].sort((a, b) => a - b)
                      : scheduleWindow.days.filter((day) => day !== value);
                    setScheduleWindow({ ...scheduleWindow, days });
                  }}
                  className="accent-purple-500"
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="mt-4 text-xs text-amber-200">
          Changes apply within about one minute without restarting the app. Changing any schedule setting after a job has run can make that job run again today if today is selected and time remains in the new window. Avoid changing settings unless you intend to reschedule/re-run today&apos;s jobs.
        </p>
        <div className="mt-4 flex justify-end">
          <button
            onClick={() => onSaveSchedule(scheduleWindow)}
            disabled={
              savingSchedule ||
              !sysConfig ||
              scheduleWindow.end < scheduleWindow.start ||
              scheduleWindow.days.length === 0
            }
            className="rounded-lg border border-purple-500 bg-purple-700 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-purple-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {savingSchedule ? "Saving…" : "Save Schedule"}
          </button>
        </div>
        {scheduleWindow.end < scheduleWindow.start && (
          <p className="mt-2 text-sm text-red-300">End time must be the same as or later than the start time.</p>
        )}
        {scheduleWindow.days.length === 0 && (
          <p className="mt-2 text-sm text-red-300">Select at least one day.</p>
        )}
      </Card>

      <Card title="Environment Variables Setup" icon="⚙️">
        <p className="text-slate-400 text-sm mb-6">
          Add these variables to your <code className="bg-slate-700 px-1 rounded">.env</code> file.
          Never commit secrets to version control.
        </p>

        <div className="space-y-6">
          {/* SMTP */}
          <EnvSection title="📧 Email (SMTP)" color="blue">
            <EnvVarRow envKey="SMTP_HOST" example="smtp.gmail.com" desc="SMTP server hostname" />
            <EnvVarRow envKey="SMTP_PORT" example="587" desc="SMTP port (587 for TLS, 465 for SSL)" />
            <EnvVarRow envKey="SMTP_SECURE" example="false" desc="true for port 465 (SSL)" />
            <EnvVarRow envKey="SMTP_USER" example="you@gmail.com" desc="Your email address" />
            <EnvVarRow envKey="SMTP_PASS" example="your-app-password" desc="App password (not your login password)" />
            <EnvVarRow envKey="SMTP_FROM" example='"Tech Team" <you@gmail.com>' desc="From display name and address" />
            <EnvVarRow envKey="ROSTER_EMAIL_TO" example="mgmt@company.com,cto@company.com" desc="Fallback recipients; frontend settings override these" />
            <EnvVarRow envKey="ROSTER_EMAIL_CC" example="hr@company.com" desc="Fallback CC; frontend settings override these" />
            <EnvVarRow envKey="CONNECTIVITY_EMAIL_TO" example="noc@company.com,mgmt@company.com" desc="Fallback recipients; frontend settings override these" />
            <EnvVarRow envKey="CONNECTIVITY_EMAIL_CC" example="" desc="Fallback CC; frontend settings override these" />
          </EnvSection>

          {/* Telegram */}
          <EnvSection title="💬 Telegram Bot" color="teal">
            <EnvVarRow envKey="TELEGRAM_BOT_TOKEN" example="123456:ABC-DEF..." desc="From @BotFather on Telegram" />
            <EnvVarRow envKey="TELEGRAM_CHAT_ID" example="987654321" desc="Your personal chat ID (use @userinfobot to find it)" />
            <div className="mt-4 bg-teal-900/20 border border-teal-500/30 rounded-xl p-4 text-sm space-y-2">
              <p className="text-teal-300 font-semibold">🤖 Telegram Setup Steps:</p>
              <ol className="text-slate-300 space-y-1 ml-4">
                <li>1. Open Telegram, search for <strong>@BotFather</strong></li>
                <li>2. Send <code>/newbot</code> and follow prompts</li>
                <li>3. Copy the token and set it as TELEGRAM_BOT_TOKEN</li>
                <li>4. Start a chat with your bot, send a message</li>
                <li>5. Search <strong>@userinfobot</strong> to get your Chat ID</li>
                <li>6. Set that as TELEGRAM_CHAT_ID</li>
              </ol>
            </div>
          </EnvSection>

          {/* ASA */}
          <EnvSection title="🔥 ASA Firewall SSH" color="orange">
            <EnvVarRow envKey="ASA_HOST" example="192.168.1.1" desc="ASA management IP address" />
            <EnvVarRow envKey="ASA_PORT" example="22" desc="SSH port (default 22)" />
            <EnvVarRow envKey="ASA_USER" example="admin" desc="SSH username" />
            <EnvVarRow envKey="ASA_PASS" example="your-ssh-password" desc="SSH password" />
            <EnvVarRow envKey="ASA_ENABLE_PASS" example="enable-secret" desc="Enable mode password (if required)" />
          </EnvSection>

          {/* QAdmin */}
          <EnvSection title="📷 QAdmin Queue Screenshot" color="teal">
            <EnvVarRow envKey="QADMIN_BASE_URL" example="http://npch.infotelebd.com:8080/QAdmin/" desc="Portal login URL" />
            <EnvVarRow envKey="QADMIN_QUEUE_URL" example="http://npch.infotelebd.com:8080/QAdmin/pages/admin/queueManagement.xhtml" desc="Outgoing queue page URL" />
            <EnvVarRow envKey="QADMIN_USERNAME" example="your-portal-username" desc="Portal login username" />
            <EnvVarRow envKey="QADMIN_PASSWORD" example="set-in-local-env" desc="Portal login password; keep secret and never commit it" />
            <EnvVarRow envKey="QADMIN_QUEUE_SELECTOR" example=".ui-datatable:has(.ui-datatable-header:has-text(&quot;Queue Management&quot;))" desc="Optional selector for the queue section to crop" />
          </EnvSection>

          {/* Excel */}
          <EnvSection title="📊 Excel File" color="green">
            <EnvVarRow envKey="CONNECTIVITY_EXCEL_PATH" example="./data/connectivity.xlsx" desc="Path to Excel file (will be created if not exists)" />
            <EnvVarRow envKey="EXCEL_SHEET_PREFIX" example="Connectivity" desc="Sheet name prefix (e.g. 'Connectivity 2024-01-15')" />
          </EnvSection>

          <EnvSection title="⚙️ General" color="purple">
            <EnvVarRow envKey="CONFIRM_TIMEOUT_MS" example="1800000" desc="Telegram confirmation timeout in ms (default: 30 mins)" />
          </EnvSection>
        </div>
      </Card>

      {/* Current Status */}
      {sysConfig && (
        <Card title="Current Configuration Status" icon="🔍">
          <div className="grid md:grid-cols-3 gap-4">
            <StatusCheckItem label="SMTP Email" ok={sysConfig.smtp.ok} detail={sysConfig.smtp.user} />
            <StatusCheckItem label="Telegram Bot" ok={sysConfig.telegram.ok} detail={`Chat ID: ${sysConfig.telegram.chatId}`} />
            <StatusCheckItem label="ASA Firewall" ok={sysConfig.asa.ok} detail={`Host: ${sysConfig.asa.host}`} />
          </div>
        </Card>
      )}
    </div>
  );
}

function RecipientField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-sm font-medium text-slate-200">{label}</span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={2}
        spellCheck={false}
        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
        placeholder="name@example.com, another@example.com"
      />
    </label>
  );
}

function EnvSection({ title, color, children }: { title: string; color: string; children: React.ReactNode }) {
  const colorMap: Record<string, string> = {
    blue: "border-blue-500/30 bg-blue-900/10",
    teal: "border-teal-500/30 bg-teal-900/10",
    orange: "border-orange-500/30 bg-orange-900/10",
    green: "border-green-500/30 bg-green-900/10",
    purple: "border-purple-500/30 bg-purple-900/10",
  };
  return (
    <div className={`border rounded-xl p-5 ${colorMap[color] ?? ""}`}>
      <h3 className="font-semibold text-slate-200 mb-4">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function EnvVarRow({ envKey, example, desc }: { envKey: string; example: string; desc: string }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-2">
      <code className="text-yellow-400 font-mono text-xs bg-slate-800 px-2 py-1 rounded whitespace-nowrap min-w-[240px]">
        {envKey}=
      </code>
      <div className="flex-1">
        <code className="text-green-300 text-xs">{example || "(empty)"}</code>
        <p className="text-slate-500 text-xs mt-0.5">{desc}</p>
      </div>
    </div>
  );
}

function StatusCheckItem({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={`border rounded-xl p-4 ${ok ? "border-green-500/30 bg-green-900/10" : "border-red-500/30 bg-red-900/10"}`}>
      <div className="flex items-center gap-2 mb-2">
        <span>{ok ? "✅" : "❌"}</span>
        <span className="font-medium text-slate-200 text-sm">{label}</span>
      </div>
      <p className={`text-xs ${ok ? "text-green-400" : "text-red-400"}`}>{ok ? "Connected" : "Not configured"}</p>
      <p className="text-slate-500 text-xs mt-1 font-mono">{detail}</p>
    </div>
  );
}
