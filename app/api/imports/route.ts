import { NextResponse } from "next/server";
import { importAccessError } from "@/lib/imports/access";
import { DatabaseUnavailableError, getImportStatus } from "@/lib/imports/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const accessError = importAccessError(request);
  if (accessError) return NextResponse.json({ error: accessError.message }, { status: accessError.status });
  try {
    const latest = await getImportStatus();
    const imports = Object.fromEntries(Object.entries(latest).map(([kind, batch]) => [kind, batch && ({
      id: batch.id,
      kind: batch.kind,
      sourceName: batch.sourceName,
      sourceSystem: batch.sourceSystem,
      exportId: batch.exportId,
      exportedAt: batch.exportedAt,
      checkedAt: batch.checkedAt,
      importedAt: batch.importedAt,
      rowCount: batch.rowCount,
      importVersion: batch.importVersion,
    })]));
    return NextResponse.json({ imports });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("Could not read import status", error);
    return NextResponse.json({ error: "Could not read saved import status." }, { status: 503 });
  }
}

