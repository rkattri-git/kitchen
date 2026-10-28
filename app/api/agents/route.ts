import { NextResponse } from "next/server";
import { AgentRunError, savePlanningAgentRun } from "@/lib/agents/planning";
import { importAccessError } from "@/lib/imports/access";
import { prisma } from "@/lib/prisma";
import { readCurrentPlan } from "@/lib/plan/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const accessError = importAccessError(request);
  if (accessError) return NextResponse.json({ error: accessError.message }, { status: accessError.status });
  try {
    const plan = await readCurrentPlan();
    if (!plan.ready) return NextResponse.json({ ready: false, missingImports: plan.missingImports, missingReferences: plan.missingReferences }, { headers: { "Cache-Control": "no-store" } });
    const saved = await prisma.agentRun.findFirst({
      where: { importVersion: plan.importVersion },
      orderBy: { createdAt: "desc" },
      select: { id: true, importVersion: true, model: true, result: true, createdAt: true },
    });
    return NextResponse.json({ ready: true, run: saved ? { ...saved, createdAt: saved.createdAt.toISOString() } : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not read saved planning agent run", error);
    return NextResponse.json({ error: "Could not read saved planning recommendations." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const accessError = importAccessError(request);
  if (accessError) return NextResponse.json({ error: accessError.message }, { status: accessError.status });
  try {
    const plan = await readCurrentPlan();
    if (!plan.ready) return NextResponse.json({ error: "Import stock, staff, leave, availability and CRM data before running the planning agents.", missingImports: plan.missingImports }, { status: 409 });
    const run = await savePlanningAgentRun(plan);
    return NextResponse.json({ ready: true, run }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AgentRunError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Planning agent run failed", error);
    return NextResponse.json({ error: "Planning agents failed. The verified numeric plan remains available; check server configuration and try again." }, { status: 503 });
  }
}

