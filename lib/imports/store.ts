import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { ImportKind, ValidatedImport } from "./validation";

export class DatabaseUnavailableError extends Error {}

function ensureDatabase(): void {
  if (!process.env.DATABASE_URL) throw new DatabaseUnavailableError("DATABASE_URL is not configured. Add a Postgres connection before importing records.");
}

export async function currentStaffIds(): Promise<Set<string>> {
  ensureDatabase();
  const latestStaff = await prisma.importBatch.findFirst({
    where: { kind: "hr_staff" },
    orderBy: [{ importedAt: "desc" }, { importVersion: "desc" }],
    include: { records: true },
  });
  return new Set((latestStaff?.records ?? []).map((record) => record.recordKey));
}

export async function saveImport(importData: ValidatedImport, contents: Uint8Array) {
  ensureDatabase();
  const contentHash = createHash("sha256").update(contents).digest("hex");
  return prisma.$transaction(async (tx) => {
    const duplicate = await tx.importBatch.findUnique({ where: { kind_contentHash: { kind: importData.kind, contentHash } } });
    if (duplicate) return { batch: duplicate, duplicate: true };
    const latest = await tx.importBatch.findFirst({ orderBy: { importVersion: "desc" }, select: { importVersion: true } });
    const importVersion = (latest?.importVersion ?? 0) + 1;
    const batch = await tx.importBatch.create({
      data: {
        kind: importData.kind,
        sourceName: importData.sourceName,
        sourceSystem: importData.sourceSystem,
        exportId: importData.exportId,
        exportedAt: importData.exportedAt,
        checkedAt: importData.checkedAt,
        rowCount: importData.rowCount,
        contentHash,
        importVersion,
        records: { create: importData.records.map((record) => ({ recordKey: record.recordKey, value: record.value as Prisma.InputJsonValue })) },
      },
    });
    return { batch, duplicate: false };
  });
}

export async function getImportStatus() {
  ensureDatabase();
  const batches = await prisma.importBatch.findMany({ orderBy: [{ importedAt: "desc" }, { importVersion: "desc" }] });
  const latest: Partial<Record<ImportKind, (typeof batches)[number]>> = {};
  for (const batch of batches) if (!(batch.kind in latest)) latest[batch.kind as ImportKind] = batch;
  return latest;
}

