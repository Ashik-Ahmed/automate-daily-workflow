/**
 * POST /api/roster/upload
 * Upload a CSV/JSON file with monthly roster.
 * Expected CSV columns: name,shift,date,notes
 * Expected JSON: array of { employeeName, shift, date, notes }
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rosterEntries } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { format, isValid, parse, parseISO } from "date-fns";
import ExcelJS from "exceljs";
import { normalizeRosterShift } from "@/lib/roster-shifts";
import { saveHolidayDates } from "@/lib/holiday-calendar";

export const dynamic = "force-dynamic";

interface RosterRow {
  employeeName: string;
  shift: string;
  date: string;
  notes?: string;
}

function parseCSV(text: string): RosterRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0]!.toLowerCase().split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    const cols = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const get = (field: string) => cols[headers.indexOf(field)] ?? "";

    // Support both "name" and "employeename"
    const name = get("employeename") || get("name") || get("employee");
    const shift = normalizeRosterShift(get("shift") || "Daytime (Office)");
    let date = get("date");
    const notes = get("notes");

    // Attempt to normalise date
    if (date) {
      const parsed = parseISO(date);
      if (isValid(parsed)) date = format(parsed, "yyyy-MM-dd");
    }

    return { employeeName: name, shift, date, notes };
  }).filter((r) => r.employeeName && r.date);
}

function normalizeDate(value: unknown): string | undefined {
  if (value instanceof Date && isValid(value)) return format(value, "yyyy-MM-dd");
  if (typeof value === "number") {
    const parsed = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
    return isValid(parsed) ? format(parsed, "yyyy-MM-dd") : undefined;
  }
  if (typeof value !== "string" || !value.trim()) return undefined;

  const text = value.trim();
  const isoDate = parseISO(text);
  if (isValid(isoDate)) return format(isoDate, "yyyy-MM-dd");
  for (const dateFormat of ["dd.MM.yyyy", "dd MMMM yyyy", "MMMM d, yyyy"]) {
    const parsed = parse(text, dateFormat, new Date());
    if (isValid(parsed)) return format(parsed, "yyyy-MM-dd");
  }
  return undefined;
}

function shiftFromHeader(header: string): string | undefined {
  const normalized = header.toLowerCase().replace(/\s+/g, " ").trim();
  if (normalized.includes("date")) return undefined;
  if (normalized.includes("daytime") && normalized.includes("home")) {
    return "Daytime (Home/Office)";
  }
  if (normalized.includes("daytime") && normalized.includes("office")) {
    return "Daytime (Office)";
  }
  if (normalized.includes("evening")) return "Evening (Home)";
  if (normalized.includes("morning")) return "Morning Report";
  return undefined;
}

async function parseExcelRoster(buffer: ArrayBuffer): Promise<RosterRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The Excel workbook has no worksheets");

  const headers = new Map<number, string>();
  let dateColumn: number | undefined;
  for (let column = 1; column <= worksheet.columnCount; column++) {
    const header = worksheet.getCell(1, column).text.trim();
    if (!header) continue;
    if (header.toLowerCase().includes("date")) {
      dateColumn = column;
      continue;
    }
    const shift = shiftFromHeader(header);
    if (!shift) {
      throw new Error(`Unsupported roster column header: ${header}`);
    }
    headers.set(column, shift);
  }

  if (dateColumn === undefined || headers.size === 0) {
    throw new Error("Excel roster must have a Date column and Daytime, Evening, or Morning Report columns");
  }

  const rows: RosterRow[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const date = normalizeDate(row.getCell(dateColumn).value);
    if (!date) continue;

    const holiday = [...headers.keys()]
      .map((column) => row.getCell(column).text.trim())
      .find((value) => /holiday|durga puja/i.test(value));
    if (holiday) {
      rows.push({ employeeName: holiday, shift: "Holiday", date });
      continue;
    }

    for (const [column, shift] of headers) {
      const employeeName = row.getCell(column).text.trim();
      if (employeeName) rows.push({ employeeName, shift: normalizeRosterShift(shift), date });
    }
  }
  return rows;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const replaceDate = formData.get("replaceDate") as string | null;

    if (!file) {
      return NextResponse.json({ ok: false, error: "No file uploaded" }, { status: 400 });
    }

    const filename = file.name.toLowerCase();
    let rows: RosterRow[] = [];

    if (filename.endsWith(".xlsx")) {
      rows = await parseExcelRoster(await file.arrayBuffer());
    } else if (filename.endsWith(".json")) {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      rows = Array.isArray(parsed) ? (parsed as RosterRow[]) : [];
    } else if (filename.endsWith(".csv")) {
      rows = parseCSV(await file.text());
    } else {
      return NextResponse.json(
        { ok: false, error: "Upload an .xlsx, .csv, or .json roster file" },
        { status: 400 }
      );
    }

    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid rows found in file" }, { status: 400 });
    }

    const holidayRows = rows.filter(
      (row) =>
        row.shift.toLowerCase() === "holiday" ||
        /holiday|durga puja/i.test(row.employeeName.trim())
    );
    const rosterRows = rows.filter((row) => !holidayRows.includes(row));
    if (holidayRows.length > 0) {
      await saveHolidayDates(
        holidayRows.map((row) => ({
          date: row.date,
          name: /holiday|durga puja/i.test(row.employeeName) ? row.employeeName : "Holiday",
        }))
      );
    }

    const datesToReplace = [...new Set([...rows.map((row) => row.date), ...(replaceDate ? [replaceDate] : [])])];
    const inserted = await db.transaction(async (tx) => {
      await tx.delete(rosterEntries).where(inArray(rosterEntries.date, datesToReplace));
      if (rosterRows.length === 0) return [];
      return tx.insert(rosterEntries)
        .values(
          rosterRows.map((row) => ({
            employeeName: row.employeeName,
            shift: row.shift,
            date: row.date,
            notes: row.notes ?? null,
          }))
        )
        .returning();
    });

    return NextResponse.json({
      ok: true,
      count: inserted.length,
      dates: [...new Set(rows.map((r) => r.date))].sort(),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
