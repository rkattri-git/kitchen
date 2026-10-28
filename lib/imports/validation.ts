import { parse } from "node:path";

export type ImportKind = "stock" | "hr_staff" | "hr_leave" | "hr_availability" | "crm_orders";
export type ImportRecord = { recordKey: string; value: Record<string, unknown> };
export type ValidatedImport = {
  kind: ImportKind;
  sourceName: string;
  sourceSystem?: string;
  exportId?: string;
  exportedAt?: Date;
  checkedAt?: Date;
  rowCount: number;
  records: ImportRecord[];
};

export class ImportValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super("The uploaded file did not pass validation.");
    this.name = "ImportValidationError";
  }
}

const CRM_COLUMNS = ["export_id", "exported_at", "export_status", "id", "production_date", "customer", "product_id", "quantity", "status", "received_at"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateTime(value: unknown): Date | undefined {
  if (typeof value !== "string" || !ISO_DATETIME_WITH_ZONE.test(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ImportValidationError(["The file is not valid JSON."]);
  }
}

function fileName(name: string): string {
  return parse(name.replace(/[\\/]/g, "")).base.slice(0, 160) || "upload";
}

function requireJsonFile(name: string): void {
  if (!name.toLowerCase().endsWith(".json")) throw new ImportValidationError(["Upload a .json file for this import."]);
}

function assertEnvelope(value: unknown): { sourceSystem: string; exportId: string; exportedAt: Date; effectiveMonth: string; records: unknown[] } {
  if (!isObject(value)) throw new ImportValidationError(["The HR export must be a JSON object."]);
  const issues: string[] = [];
  if (!nonEmptyString(value.source_system)) issues.push("source_system must be a non-empty string.");
  if (!nonEmptyString(value.export_id)) issues.push("export_id must be a non-empty string.");
  const exportedAt = dateTime(value.exported_at);
  if (!exportedAt) issues.push("exported_at must be an ISO timestamp with a time zone.");
  if (typeof value.effective_month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.effective_month)) issues.push("effective_month must use YYYY-MM format.");
  if (!Array.isArray(value.records) || value.records.length === 0) issues.push("records must contain at least one row.");
  if (issues.length) throw new ImportValidationError(issues);
  return {
    sourceSystem: value.source_system as string,
    exportId: value.export_id as string,
    exportedAt: exportedAt as Date,
    effectiveMonth: value.effective_month as string,
    records: value.records as unknown[],
  };
}

function jsonRows(kind: Exclude<ImportKind, "crm_orders">, name: string, text: string, knownStaffIds: Set<string>): ValidatedImport {
  requireJsonFile(name);
  const input = parseJson(text);
  const issues: string[] = [];
  let rows: unknown[] = [];
  let sourceSystem: string | undefined;
  let exportId: string | undefined;
  let exportedAt: Date | undefined;
  let checkedAt: Date | undefined;
  let effectiveMonth: string | undefined;

  if (kind === "stock") {
    if (!Array.isArray(input) || input.length === 0) throw new ImportValidationError(["The stock count must be a non-empty JSON array."]);
    rows = input;
  } else {
    const envelope = assertEnvelope(input);
    ({ sourceSystem, exportId, exportedAt, effectiveMonth, records: rows } = envelope);
  }

  const seen = new Set<string>();
  const records: ImportRecord[] = [];
  for (const [index, row] of rows.entries()) {
    const label = `Row ${index + 1}`;
    if (!isObject(row)) {
      issues.push(`${label} must be a JSON object.`);
      continue;
    }
    if (kind === "stock") {
      const id = row.ingredient_id;
      if (!nonEmptyString(id)) { issues.push(`${label}: ingredient_id is required.`); continue; }
      if (seen.has(id)) issues.push(`${label}: duplicate ingredient_id ${id}.`);
      seen.add(id);
      for (const field of ["name", "unit", "pack_name"] as const) if (!nonEmptyString(row[field])) issues.push(`${label}: ${field} is required.`);
      for (const field of ["on_hand", "committed", "pack_size"] as const) {
        const value = row[field];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (field === "pack_size" && value <= 0)) issues.push(`${label}: ${field} must be ${field === "pack_size" ? "a positive" : "a non-negative"} number.`);
      }
      const timestamp = dateTime(row.checked_at);
      if (!timestamp) issues.push(`${label}: checked_at must be an ISO timestamp with a time zone.`);
      checkedAt ??= timestamp;
      if (timestamp && checkedAt && timestamp.getTime() !== checkedAt.getTime()) issues.push("All stock rows must use the same checked_at timestamp.");
      records.push({ recordKey: id, value: row });
      continue;
    }

    if (kind === "hr_staff") {
      const id = row.id;
      if (!nonEmptyString(id)) { issues.push(`${label}: id is required.`); continue; }
      if (seen.has(id)) issues.push(`${label}: duplicate staff id ${id}.`);
      seen.add(id);
      if (!nonEmptyString(row.name)) issues.push(`${label}: name is required.`);
      if (row.employment_type !== "Permanent" && row.employment_type !== "Part-time") issues.push(`${label}: employment_type must be Permanent or Part-time.`);
      if (!nonEmptyString(row.role)) issues.push(`${label}: role is required.`);
      if (!Array.isArray(row.skills) || !row.skills.length || row.skills.some((skill) => !nonEmptyString(skill))) issues.push(`${label}: skills must be a non-empty list of strings.`);
      records.push({ recordKey: id, value: row });
      continue;
    }

    const staffId = row.staff_id;
    const id = row.id;
    if (!nonEmptyString(staffId)) issues.push(`${label}: staff_id is required.`);
    else if (!knownStaffIds.has(staffId)) issues.push(`${label}: staff_id ${staffId} is not in the latest imported staff master.`);
    if (kind === "hr_leave") {
      if (!nonEmptyString(id)) issues.push(`${label}: id is required.`);
      if (!validDate(row.date)) issues.push(`${label}: date must be a real YYYY-MM-DD date.`);
      if (!nonEmptyString(row.status) || !["Approved", "Pending", "Rejected", "Cancelled"].includes(row.status)) issues.push(`${label}: status is not recognized.`);
      if (row.reason !== undefined && !nonEmptyString(row.reason)) issues.push(`${label}: reason must be a non-empty string when provided.`);
      const key = nonEmptyString(id) ? id : `row-${index + 1}`;
      if (seen.has(key)) issues.push(`${label}: duplicate leave id ${key}.`);
      seen.add(key);
      records.push({ recordKey: key, value: row });
    } else {
      if (!validDate(row.date)) issues.push(`${label}: date must be a real YYYY-MM-DD date.`);
      if (typeof row.start !== "string" || !TIME.test(row.start)) issues.push(`${label}: start must use HH:mm format.`);
      if (typeof row.end !== "string" || !TIME.test(row.end)) issues.push(`${label}: end must use HH:mm format.`);
      if (typeof row.start === "string" && TIME.test(row.start) && typeof row.end === "string" && TIME.test(row.end) && row.start >= row.end) issues.push(`${label}: end must be later than start.`);
      if (!nonEmptyString(row.status) || !["Confirmed", "Pending", "Cancelled"].includes(row.status)) issues.push(`${label}: status is not recognized.`);
      const key = `${staffId ?? "unknown"}:${row.date ?? "unknown"}:${row.start ?? "unknown"}`;
      if (seen.has(key)) issues.push(`${label}: duplicate availability ${key}.`);
      seen.add(key);
      records.push({ recordKey: key, value: row });
    }
  }
  if (issues.length) throw new ImportValidationError(issues);

  return {
    kind,
    sourceName: fileName(name),
    sourceSystem,
    exportId,
    exportedAt,
    checkedAt,
    rowCount: records.length,
    records: records.map(({ recordKey, value }) => ({ recordKey, value: effectiveMonth ? { ...value, effective_month: effectiveMonth } : value })),
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ",") { row.push(value); value = ""; }
    else if (char === "\n") { row.push(value.replace(/\r$/, "")); if (row.some((cell) => cell.length)) rows.push(row); row = []; value = ""; }
    else value += char;
  }
  if (quoted) throw new ImportValidationError(["The CRM CSV contains an unclosed quoted field."]);
  if (value.length || row.length) { row.push(value.replace(/\r$/, "")); if (row.some((cell) => cell.length)) rows.push(row); }
  return rows;
}

function crmRows(name: string, text: string, knownProductIds: Set<string>): ValidatedImport {
  if (!name.toLowerCase().endsWith(".csv")) throw new ImportValidationError(["Upload a .csv file for CRM orders."]);
  const csvRows = parseCsv(text);
  if (csvRows.length < 2) throw new ImportValidationError(["The CRM CSV must contain a header and at least one order row."]);
  const headers = csvRows[0].map((header) => header.trim());
  const missing = CRM_COLUMNS.filter((column) => !headers.includes(column));
  const extra = headers.filter((column) => !CRM_COLUMNS.includes(column));
  const issues: string[] = [];
  if (missing.length) issues.push(`Missing required columns: ${missing.join(", ")}.`);
  if (extra.length) issues.push(`Unexpected columns: ${extra.join(", ")}.`);
  if (new Set(headers).size !== headers.length) issues.push("The CRM CSV has duplicate column names.");
  if (issues.length) throw new ImportValidationError(issues);

  const seen = new Set<string>();
  const orderRecords: ImportRecord[] = [];
  let exportId: string | undefined;
  let exportedAt: Date | undefined;
  for (const [index, cells] of csvRows.slice(1).entries()) {
    const label = `Row ${index + 2}`;
    if (cells.length !== headers.length) { issues.push(`${label}: expected ${headers.length} cells, got ${cells.length}.`); continue; }
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex].trim()])) as Record<string, string>;
    for (const field of CRM_COLUMNS) if (!nonEmptyString(row[field])) issues.push(`${label}: ${field} is required.`);
    if (exportId && row.export_id !== exportId) issues.push(`${label}: export_id does not match the rest of this file.`);
    exportId ??= row.export_id;
    const parsedExportTime = dateTime(row.exported_at);
    if (!parsedExportTime) issues.push(`${label}: exported_at must be an ISO timestamp with a time zone.`);
    if (exportedAt && parsedExportTime && exportedAt.getTime() !== parsedExportTime.getTime()) issues.push(`${label}: exported_at does not match the rest of this file.`);
    exportedAt ??= parsedExportTime;
    if (!validDate(row.production_date)) issues.push(`${label}: production_date must be a real YYYY-MM-DD date.`);
    if (!dateTime(row.received_at)) issues.push(`${label}: received_at must be an ISO timestamp with a time zone.`);
    if (!knownProductIds.has(row.product_id)) issues.push(`${label}: unknown product_id ${row.product_id}.`);
    if (!/^\d+$/.test(row.quantity) || Number(row.quantity) <= 0) issues.push(`${label}: quantity must be a positive whole number.`);
    if (seen.has(row.id)) issues.push(`${label}: duplicate order id ${row.id}.`);
    seen.add(row.id);
    orderRecords.push({ recordKey: row.id, value: row });
  }
  if (issues.length) throw new ImportValidationError(issues);
  return { kind: "crm_orders", sourceName: fileName(name), exportId, exportedAt, rowCount: orderRecords.length, records: orderRecords };
}

export function validateUpload(kind: ImportKind, name: string, text: string, knownProductIds: Set<string>, knownStaffIds: Set<string>): ValidatedImport {
  if (kind === "crm_orders") return crmRows(name, text.replace(/^\uFEFF/, ""), knownProductIds);
  return jsonRows(kind, name, text, knownStaffIds);
}

export function parseImportKind(value: string): ImportKind | undefined {
  return ["stock", "hr_staff", "hr_leave", "hr_availability", "crm_orders"].includes(value) ? value as ImportKind : undefined;
}

