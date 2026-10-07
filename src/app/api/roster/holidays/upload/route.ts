import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { normalizeHolidayDate, saveHolidayDates } from "@/lib/holiday-calendar";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Select an Excel holiday calendar" }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      return NextResponse.json({ error: "Holiday calendar must be an .xlsx file" }, { status: 400 });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return NextResponse.json({ error: "The Excel workbook has no worksheets" }, { status: 400 });
    }

    let dateColumn: number | undefined;
    let nameColumn: number | undefined;
    for (let column = 1; column <= worksheet.columnCount; column++) {
      const header = worksheet.getCell(1, column).text.trim().toLowerCase();
      if (header.includes("date")) dateColumn = column;
      if (["holiday", "name", "event", "description"].includes(header)) nameColumn = column;
    }
    if (!dateColumn) {
      return NextResponse.json({ error: "Excel calendar must have a Date column in the first row" }, { status: 400 });
    }

    const holidays = new Map<string, string>();
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const date = normalizeHolidayDate(row.getCell(dateColumn).value);
      if (!date) continue;
      const name = nameColumn ? row.getCell(nameColumn).text.trim() : "Holiday";
      holidays.set(date, name || "Holiday");
    }
    if (holidays.size === 0) {
      return NextResponse.json({ error: "No valid holiday dates found in the workbook" }, { status: 400 });
    }

    const dates = [...holidays].map(([date, name]) => ({ date, name }));
    await saveHolidayDates(dates);
    return NextResponse.json({ ok: true, count: dates.length, dates: dates.map(({ date }) => date) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}