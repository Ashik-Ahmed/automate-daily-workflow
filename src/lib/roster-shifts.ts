export const ROSTER_SHIFT_OPTIONS = [
  "Daytime (Office)",
  "Daytime (Home/Office)",
  "Evening (Home)",
  "Morning Report",
  "Holiday",
] as const;

export function normalizeRosterShift(value: string): string {
  const shift = value.trim();
  const normalized = shift.toLowerCase().replace(/\s+/g, " ");

  if (normalized === "holiday" || normalized.includes("durga puja")) return "Holiday";
  if (normalized.includes("daytime") && normalized.includes("home")) {
    return "Daytime (Home/Office)";
  }
  if (normalized === "day" || normalized === "daytime" || normalized.includes("daytime") || normalized === "office") {
    return "Daytime (Office)";
  }
  if (normalized === "night" || normalized === "evening" || normalized.includes("evening")) {
    return "Evening (Home)";
  }
  if (normalized.includes("morning")) return "Morning Report";

  return shift || ROSTER_SHIFT_OPTIONS[0];
}