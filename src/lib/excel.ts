/**
 * Excel helper — appends a new sheet with today's connectivity results
 * to the existing workbook file (or creates it if missing).
 */

import ExcelJS from "exceljs";
import * as fs from "fs";
import * as path from "path";
import { cfg } from "./config";
import { getReportableAsaOutput } from "./asa-output-image";
import { format, parseISO } from "date-fns";

const fixedPeerRows = [
  ["119.30.37.30", "10.10.16.76", "active (up)"],
  ["203.223.95.122", "10.74.43.1", ""],
  ["203.223.95.126", "10.74.43.1", ""],
  ["203.223.93.33", "10.74.10.10", "active (up)"],
  ["202.134.15.180 (IKEv2)", "10.101.76.0 (-32)", "active (up)"],
  ["103.230.107.231", "10.20.27.135", "active (up)"],
  ["182.163.98.81", "172.23.16.4 (IOF - 2)", "active (up)"],
  ["202.84.33.211", "172.23.17.4 (IOF - 0)", "active (up)"],
  ["180.211.232.98", "10.20.30.68", "active (up)"],
  ["119.40.82.242(243)", "10.98.23.1", "active (up)"],
  ["103.91.54.5", "192.168.40.10", ""],
  ["122.152.48.222", "192.168.50.10 (Secondary)", ""],
  ["123.136.28.206", "103.123.11.162", "active (up)"],
  ["", "10.101.33.72", ""],
  ["220.247.161.226", "", "active (up)"],
  ["82.149.6.229", "", "active (up)"],
  ["202.84.44.65", "", "active (up)"],
  ["182.163.102.84", "", "active (up)"],
  ["192.144.80.90", "", "active (up)"],
  ["103.134.91.14", "192.168.200.100", "active (up)"],
  ["123.136.28.206", "", "active (up)"],
];

export async function appendConnectivitySheet(
  rawOutput: string,
  checkDate: string // YYYY-MM-DD
): Promise<string> {
  const filePath = path.resolve(cfg.excel.filePath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(filePath)) {
    await wb.xlsx.readFile(filePath);
  }

  const sheetName = format(parseISO(checkDate), "dd.MM.yyyy");
  // Remove old sheet with same name if re-running
  const existing = wb.getWorksheet(sheetName);
  if (existing) {
    wb.removeWorksheet(existing.id);
  }

  const ws = wb.addWorksheet(sheetName);
  ws.getCell("A1").value = "IPSEC IP";
  ws.getCell("B1").value = "Host IP";
  ws.getCell("C1").value = "Status";
  for (const cell of [ws.getCell("A1"), ws.getCell("B1"), ws.getCell("C1")]) {
    cell.font = { bold: true };
  }

  fixedPeerRows.forEach((values, index) => {
    const rowNumber = index + 2;
    values.forEach((value, columnIndex) => {
      ws.getCell(rowNumber, columnIndex + 1).value = value;
    });
  });

  getReportableAsaOutput(rawOutput).split("\n").forEach((line, index) => {
    ws.getCell(index + 1, 5).value = line;
    ws.getCell(index + 1, 5).font = { name: "Arial", size: 10 };
  });

  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.value === null || cell.value === undefined || cell.value === "") return;
      cell.border = {
        top: { style: "thin", color: { argb: "FFD0D0D0" } },
        left: { style: "thin", color: { argb: "FFD0D0D0" } },
        bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
        right: { style: "thin", color: { argb: "FFD0D0D0" } },
      };
    });
  });

  ws.getColumn(1).width = 27;
  ws.getColumn(2).width = 32;
  ws.getColumn(3).width = 16;
  ws.getColumn(4).width = 3;
  ws.getColumn(5).width = 110;

  await wb.xlsx.writeFile(filePath);
  return filePath;
}
