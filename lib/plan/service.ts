import { prisma } from "@/lib/prisma";
import { calculatePlan, PlanCalculationError, type ImportSource, type RawRecord, type RecipeReference, type ScenarioReference } from "./calculations";

const IMPORT_KINDS = ["stock", "hr_staff", "hr_leave", "hr_availability", "crm_orders"] as const;
const REFERENCE_KEYS = ["scenario", "products_and_recipes", "supplier"] as const;

function asRecord(value: unknown, label: string): RawRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanCalculationError(`${label} is not a saved record object.`);
  return value as RawRecord;
}

function sourceFromBatch(batch: { sourceName: string; sourceSystem: string | null; exportId: string | null; exportedAt: Date | null; checkedAt: Date | null; importedAt: Date; rowCount: number; importVersion: number }): ImportSource {
  return {
    sourceName: batch.sourceName,
    sourceSystem: batch.sourceSystem,
    exportId: batch.exportId,
    exportedAt: batch.exportedAt,
    checkedAt: batch.checkedAt,
    importedAt: batch.importedAt,
    rowCount: batch.rowCount,
    importVersion: batch.importVersion,
  };
}

export async function readCurrentPlan() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  const batches = await prisma.importBatch.findMany({
    where: { kind: { in: [...IMPORT_KINDS] } },
    orderBy: [{ importedAt: "desc" }, { importVersion: "desc" }],
    include: { records: true },
  });
  const latestBatches = new Map<string, (typeof batches)[number]>();
  for (const batch of batches) if (!latestBatches.has(batch.kind)) latestBatches.set(batch.kind, batch);
  const references = await prisma.referenceData.findMany({ where: { key: { in: [...REFERENCE_KEYS] } } });
  const referenceValues = new Map(references.map((reference) => [reference.key, reference.value]));

  const missingImports = IMPORT_KINDS.filter((kind) => !latestBatches.has(kind));
  const missingReferences = REFERENCE_KEYS.filter((key) => !referenceValues.has(key));
  if (missingImports.length || missingReferences.length) {
    return { ready: false as const, missingImports, missingReferences };
  }

  const sources = Object.fromEntries(IMPORT_KINDS.map((kind) => [kind, sourceFromBatch(latestBatches.get(kind)!)])) as Record<(typeof IMPORT_KINDS)[number], ImportSource>;
  const getRows = (kind: (typeof IMPORT_KINDS)[number]) => latestBatches.get(kind)!.records.map((record) => asRecord(record.value, `${kind} ${record.recordKey}`));
  const importVersion = Math.max(...batches.map((batch) => batch.importVersion));
  return calculatePlan({
    importVersion,
    scenario: referenceValues.get("scenario") as unknown as ScenarioReference,
    recipes: referenceValues.get("products_and_recipes") as unknown as RecipeReference,
    supplier: referenceValues.get("supplier") as RawRecord,
    orders: getRows("crm_orders"),
    inventory: getRows("stock"),
    staff: getRows("hr_staff"),
    leave: getRows("hr_leave"),
    availability: getRows("hr_availability"),
    sources,
  });
}

