import { NextResponse } from "next/server";
import { importAccessError } from "@/lib/imports/access";
import { readCurrentPlan } from "@/lib/plan/service";
import { PlanCalculationError } from "@/lib/plan/calculations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const accessError = importAccessError(request);
  if (accessError) return NextResponse.json({ error: accessError.message }, { status: accessError.status });
  try {
    return NextResponse.json(await readCurrentPlan(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlanCalculationError) return NextResponse.json({ error: error.message }, { status: 422 });
    if (!process.env.DATABASE_URL) return NextResponse.json({ error: "DATABASE_URL is not configured." }, { status: 503 });
    console.error("Could not calculate current plan", error);
    return NextResponse.json({ error: "Could not read the saved imports and calculate the plan." }, { status: 503 });
  }
}

