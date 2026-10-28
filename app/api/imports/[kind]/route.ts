import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { importAccessError } from "@/lib/imports/access";
import { DatabaseUnavailableError, currentStaffIds, saveImport } from "@/lib/imports/store";
import { ImportValidationError, parseImportKind, validateUpload } from "@/lib/imports/validation";

export const runtime = "nodejs";
const MAX_UPLOAD_BYTES = 1_000_000;

export async function POST(request: Request, context: { params: Promise<{ kind: string }> }) {
  const accessError = importAccessError(request);
  if (accessError) return NextResponse.json({ error: accessError.message }, { status: accessError.status });
  const { kind: rawKind } = await context.params;
  const kind = parseImportKind(rawKind);
  if (!kind) return NextResponse.json({ error: "Unknown import type." }, { status: 404 });

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file to import." }, { status: 400 });
    if (!file.size || file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "The file must be between 1 byte and 1 MB." }, { status: 413 });
    const contents = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const products = JSON.parse(await readFile(path.join(process.cwd(), "reference-data", "products_and_recipes.json"), "utf8")) as { products: Array<{ id: string }> };
    const knownProducts = new Set(products.products.map((product) => product.id));
    const knownStaff = kind === "hr_leave" || kind === "hr_availability" ? await currentStaffIds() : new Set<string>();
    const validated = validateUpload(kind, file.name, text, knownProducts, knownStaff);
    const result = await saveImport(validated, contents);
    return NextResponse.json({
      duplicate: result.duplicate,
      import: {
        id: result.batch.id,
        kind: result.batch.kind,
        sourceName: result.batch.sourceName,
        sourceSystem: result.batch.sourceSystem,
        exportId: result.batch.exportId,
        exportedAt: result.batch.exportedAt,
        checkedAt: result.batch.checkedAt,
        importedAt: result.batch.importedAt,
        rowCount: result.batch.rowCount,
        importVersion: result.batch.importVersion,
      },
    });
  } catch (error) {
    if (error instanceof ImportValidationError) return NextResponse.json({ error: error.message, issues: error.issues }, { status: 422 });
    if (error instanceof DatabaseUnavailableError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (error instanceof TypeError && error.message.toLowerCase().includes("decode")) return NextResponse.json({ error: "The file must be UTF-8 encoded." }, { status: 400 });
    console.error("Could not import file", error);
    return NextResponse.json({ error: "The import could not be saved. Check the database connection and try again." }, { status: 503 });
  }
}

