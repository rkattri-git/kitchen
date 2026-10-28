import { readFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const keys = ["scenario", "products_and_recipes", "supplier"] as const;

async function main() {
  for (const key of keys) {
    const value = JSON.parse(await readFile(path.join(process.cwd(), "reference-data", `${key}.json`), "utf8"));
    await prisma.referenceData.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

main().finally(async () => prisma.$disconnect());

