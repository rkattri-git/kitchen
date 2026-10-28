"use client";

import { useCallback, useEffect, useState } from "react";

type ImportKind = "stock" | "hr_staff" | "hr_leave" | "hr_availability" | "crm_orders";
type ImportSummary = {
  id: string;
  kind: ImportKind;
  sourceName: string;
  sourceSystem: string | null;
  exportId: string | null;
  exportedAt: string | null;
  checkedAt: string | null;
  importedAt: string;
  rowCount: number;
  importVersion: number;
};
type ImportResult = { duplicate: boolean; import: ImportSummary };
type AgentResult = {
  importVersion: number;
  model: string;
  agents: {
    sales: { summary: string; lateExceptionExplanation: string; productionActions: { date: string; focus: string }[] };
    manpower: { summary: string; staffingGapExplanation: string; verifiedCoverRequests: { date: string; uncoveredHours: number; shiftsToRequest: number; rationale: string }[] };
    purchasing: { summary: string; shortageExplanation: string; supplierDraft: { to: string; subject: string; body: string } };
  };
  handoffTrace: string[];
};
type SavedAgentRun = { id: string; importVersion: number; model: string; result: AgentResult; createdAt: string };
type PlannedOrder = { id: string; customer?: string; product_id: string; production_date: string; received_at?: string; receivedAt?: string; quantity: number; exclusionReasons?: string[] };
type PlanDay = {
  date: string;
  dayName: string;
  totalSandwiches: number;
  labourHours: number;
  products: { productId: string; productName: string; quantity: number }[];
  roster: {
    requiredLabourHours: number;
    assignedProductiveHours: number;
    uncoveredHours: number;
    extraPartTimeShiftsToRequest: number;
    supervisorCovered: boolean;
    shifts: { staffId: string; name: string; role: string; start: string; end: string; productiveHours: number; supervisor: boolean }[];
  };
};
type PlanningPlan = {
  ready: boolean;
  missingImports?: string[];
  importVersion?: number;
  planningWindow?: { timezone: string; cutoff: string; start: string; end: string };
  source?: { crmExportId: string | null; crmImportedAt: string | null; stockCheckedAt: string | null };
  orders?: { eligibleCount: number; excludedCount: number; eligible: PlannedOrder[]; excluded: PlannedOrder[] };
  weekly?: { totalSandwiches: number; totalLabourHours: number; assignedProductiveHours: number; uncoveredLabourHours: number; extraPartTimeShiftsToRequest: number; products: { productId: string; productName: string; quantity: number }[] };
  dailyProduction?: PlanDay[];
  purchasing?: {
    items: { ingredientId: string; name: string; unit: string; demand: number; stockMissing: boolean; usableStock: number | null; shortage: number | null; packSize: number | null; packName: string | null; packsToRequest: number | null; requestQuantity: number | null }[];
    missingInventoryIngredients: string[];
  };
  roster?: {
    status: string;
    approvedLeave: { staffId: string; staffName: string; date: string; reason: string }[];
    pendingLeaveAlerts: { staffId: string; staffName: string; date: string; reason: string }[];
    supervisorGaps: string[];
  };
};

const imports: { kind: ImportKind; title: string; description: string; accept: string }[] = [
  { kind: "stock", title: "Stock count", description: "Current physical inventory and supplier pack sizes.", accept: ".json,application/json" },
  { kind: "hr_staff", title: "HR staff master", description: "Import this before leave and part-time availability.", accept: ".json,application/json" },
  { kind: "hr_leave", title: "HR leave", description: "Staff IDs are checked against the latest staff master.", accept: ".json,application/json" },
  { kind: "hr_availability", title: "Part-time availability", description: "Staff IDs are checked against the latest staff master.", accept: ".json,application/json" },
  { kind: "crm_orders", title: "CRM weekly orders", description: "One validated weekly CSV export.", accept: ".csv,text/csv" },
];

const dateTimeFormat = new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" });
const dateFormat = new Intl.DateTimeFormat("en-SG", { dateStyle: "medium", timeZone: "Asia/Singapore" });
function showDate(value: string | null): string | undefined {
  return value ? `${dateTimeFormat.format(new Date(value))} SGT` : undefined;
}
function showDay(value: string, timezone = "Asia/Singapore"): string {
  return new Intl.DateTimeFormat("en-SG", { weekday: "long", day: "numeric", month: "short", timeZone: timezone }).format(new Date(`${value}T12:00:00.000Z`));
}
type ActionItem = { date: string; title: string; detail: string; type: "exception" | "staffing" | "stock" | "production" };
function buildActionItems(plan: PlanningPlan, agentRun: SavedAgentRun | null): ActionItem[] {
  if (!plan.ready || !plan.planningWindow || !plan.dailyProduction || !plan.orders || !plan.roster || !plan.purchasing) return [];
  const run = agentRun?.importVersion === plan.importVersion ? agentRun : null;
  const actions: ActionItem[] = [];
  for (const order of plan.orders.excluded) {
    actions.push({
      date: (order.received_at ?? order.production_date).slice(0, 10),
      title: `Review excluded order ${order.id}`,
      detail: `${order.customer ?? "Customer"} · ${order.quantity.toLocaleString("en-SG")} ${order.product_id} sandwiches. ${order.exclusionReasons?.join(" ") ?? "This order is outside the baseline plan."} Decide whether to accept it; it is not included in production totals.`,
      type: "exception",
    });
  }
  for (const day of plan.roster.approvedLeave) {
    actions.push({ date: day.date, title: `Approved leave · ${day.staffName}`, detail: `${day.reason}. The saved roster excludes this worker for the day.`, type: "staffing" });
  }
  for (const day of plan.roster.pendingLeaveAlerts) {
    actions.push({ date: day.date, title: `Confirm pending leave · ${day.staffName}`, detail: `${day.reason}. Review before approving the draft roster.`, type: "staffing" });
  }
  for (const day of plan.roster.supervisorGaps) {
    actions.push({ date: day, title: "Resolve supervisor coverage", detail: "No available supervisor-qualified kitchen lead is shown. Assign a qualified lead before approving the roster.", type: "staffing" });
  }
  for (const day of plan.dailyProduction) {
    if (day.roster.uncoveredHours > 0) {
      actions.push({ date: day.date, title: "Request part-time cover", detail: `The verified draft leaves ${day.roster.uncoveredHours} labour hours uncovered. Request ${day.roster.extraPartTimeShiftsToRequest} additional four-hour shift${day.roster.extraPartTimeShiftsToRequest === 1 ? "" : "s"}; no worker is booked. ${run?.result.agents.manpower.verifiedCoverRequests.find((item) => item.date === day.date)?.rationale ?? "Manager review is needed."}`, type: "staffing" });
    }
    if (day.totalSandwiches > 0) {
      const agentFocus = run?.result.agents.sales.productionActions.find((item) => item.date === day.date)?.focus;
      actions.push({ date: day.date, title: `${day.dayName} production`, detail: agentFocus ?? `Prepare ${day.totalSandwiches.toLocaleString("en-SG")} baseline sandwiches using the verified daily mix and draft roster.`, type: "production" });
    }
  }
  const shortages = plan.purchasing.items.filter((item) => !item.stockMissing && (item.packsToRequest ?? 0) > 0);
  if (shortages.length) {
    actions.push({ date: plan.planningWindow.cutoff.slice(0, 10), title: "Review supplier stock request", detail: run ? "Review the verified whole-pack draft text and decide whether to create or send a supplier request. Nothing has been sent." : "Review the verified whole-pack shortages and decide whether to prepare a supplier request before production starts.", type: "stock" });
  }
  if (plan.purchasing.missingInventoryIngredients.length) {
    actions.push({ date: plan.planningWindow.cutoff.slice(0, 10), title: "Complete missing stock count", detail: `Import a stock count for ${plan.purchasing.missingInventoryIngredients.join(", ")} before relying on purchasing quantities.`, type: "stock" });
  }
  return actions.sort((a, b) => a.date.localeCompare(b.date) || ["exception", "staffing", "stock", "production"].indexOf(a.type) - ["exception", "staffing", "stock", "production"].indexOf(b.type));
}

export default function ImportWorkspace() {
  const [token, setToken] = useState("");
  const [files, setFiles] = useState<Partial<Record<ImportKind, File>>>({});
  const [latest, setLatest] = useState<Partial<Record<ImportKind, ImportSummary>>>({});
  const [errors, setErrors] = useState<Partial<Record<ImportKind, string[]>>>({});
  const [results, setResults] = useState<Partial<Record<ImportKind, ImportResult>>>({});
  const [loading, setLoading] = useState<ImportKind | null>(null);
  const [statusMessage, setStatusMessage] = useState("Checking saved import status…");
  const [isDatabaseReady, setIsDatabaseReady] = useState(false);
  const [agentRun, setAgentRun] = useState<SavedAgentRun | null>(null);
  const [agentLoading, setAgentLoading] = useState(false);
  const [agentMessage, setAgentMessage] = useState("Checking saved recommendations…");
  const [agentError, setAgentError] = useState("");
  const [plan, setPlan] = useState<PlanningPlan | null>(null);
  const [planMessage, setPlanMessage] = useState("Loading the saved production plan…");

  const requestHeaders = useCallback((): HeadersInit => {
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    return headers;
  }, [token]);
  const refreshStatus = useCallback(async () => {
    setStatusMessage("Checking saved import status…");
    try {
      const response = await fetch("/api/imports", { headers: requestHeaders(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not read saved import status.");
      setLatest(body.imports ?? {});
      setIsDatabaseReady(true);
      setStatusMessage("Saved imports are connected to Postgres.");
    } catch (error) {
      setIsDatabaseReady(false);
      setStatusMessage(error instanceof Error ? error.message : "Could not read saved import status.");
    }
  }, [requestHeaders]);

  const refreshAgentRun = useCallback(async () => {
    try {
      const response = await fetch("/api/agents", { headers: requestHeaders(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not read saved recommendations.");
      setAgentRun(body.run ?? null);
      setAgentMessage(!body.ready ? "Import stock, HR staff, leave, part-time availability and CRM orders before running specialists." : body.run ? `Saved for import version ${body.run.importVersion}.` : "No recommendations saved for the current imports yet.");
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : "Could not read saved recommendations.");
    }
  }, [requestHeaders]);

  const refreshPlan = useCallback(async () => {
    try {
      const response = await fetch("/api/plan", { headers: requestHeaders(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not calculate the saved plan.");
      setPlan(body as PlanningPlan);
      setPlanMessage(body.ready ? "Calculated from the latest saved imports." : "Waiting for required operational imports.");
    } catch (error) {
      setPlan(null);
      setPlanMessage(error instanceof Error ? error.message : "Could not load the saved production plan.");
    }
  }, [requestHeaders]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => { void refreshAgentRun(); }, [refreshAgentRun]);
  useEffect(() => { void refreshPlan(); }, [refreshPlan]);

  async function runPlanningAgents() {
    setAgentLoading(true);
    setAgentError("");
    setAgentMessage("Running Sales first, then handing its result to Manpower and Purchasing…");
    try {
      const response = await fetch("/api/agents", { method: "POST", headers: requestHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Planning agents could not complete.");
      setAgentRun(body.run);
      setAgentMessage(`Saved for import version ${body.run.importVersion}.`);
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Planning agents could not complete. The numeric plan remains available.");
      setAgentMessage("No new recommendation was saved.");
    } finally {
      setAgentLoading(false);
    }
  }

  const planningInputsReady = imports.every(({ kind }) => Boolean(latest[kind]));
  const currentAgentRun = plan?.ready && plan.importVersion === agentRun?.importVersion ? agentRun : null;
  const actionItems = plan?.ready ? buildActionItems(plan, currentAgentRun) : [];

  async function upload(kind: ImportKind) {
    const file = files[kind];
    if (!file) {
      setErrors((current) => ({ ...current, [kind]: ["Choose a file first."] }));
      return;
    }
    setLoading(kind);
    setErrors((current) => ({ ...current, [kind]: [] }));
    setResults((current) => ({ ...current, [kind]: undefined }));
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(`/api/imports/${kind}`, { method: "POST", headers: requestHeaders(), body: form });
      const body = await response.json();
      if (!response.ok) {
        const details = Array.isArray(body.issues) ? body.issues : [body.error ?? "The import failed."];
        setErrors((current) => ({ ...current, [kind]: details }));
        return;
      }
      setResults((current) => ({ ...current, [kind]: body as ImportResult }));
      await refreshStatus();
      await refreshAgentRun();
      await refreshPlan();
    } catch {
      setErrors((current) => ({ ...current, [kind]: ["The server could not complete the import. Check the database connection and try again."] }));
    } finally {
      setLoading(null);
    }
  }

  return (
    <main className="shell imports-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Kitchen Planner home"><span className="brand-mark">K</span> Kitchen Planner</a>
        <span className="environment">Manager dashboard · local</span>
      </header>
      <section className="dashboard-main" aria-labelledby="dashboard-heading">
        <p className="eyebrow">SAMPLE CENTRAL KITCHEN · WEEK OF 2 NOV 2026</p>
        <h1 id="dashboard-heading">Next week at a glance.</h1>
        <p className="intro">The plan below is recalculated from saved stock, HR and CRM imports. Calculated quantities and named shifts remain the source of truth.</p>
        <div className={`connection-status ${plan?.ready ? "connected" : "disconnected"}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>{plan?.ready ? "Verified plan ready" : "Plan not ready"}</strong><p>{planMessage}</p></div>
          <button className="text-button" type="button" onClick={() => { void refreshPlan(); void refreshAgentRun(); }}>Refresh plan</button>
        </div>

        {plan?.ready && plan.planningWindow && plan.source && plan.orders && plan.weekly && plan.dailyProduction && plan.purchasing && plan.roster ? <>
          <div className="dashboard-kpis">
            <article><span>Eligible orders</span><strong>{plan.orders.eligibleCount}</strong><small>in the baseline</small></article>
            <article className={plan.orders.excludedCount ? "attention" : ""}><span>Exceptions</span><strong>{plan.orders.excludedCount}</strong><small>for manager review</small></article>
            <article><span>Sandwiches</span><strong>{plan.weekly.totalSandwiches.toLocaleString("en-SG")}</strong><small>across five days</small></article>
            <article><span>Productive labour</span><strong>{plan.weekly.totalLabourHours.toLocaleString("en-SG")} h</strong><small>{plan.weekly.assignedProductiveHours} h assigned · {plan.weekly.uncoveredLabourHours} h uncovered</small></article>
          </div>

          <section className="dashboard-card source-card" aria-labelledby="source-heading">
            <div className="dashboard-card-heading"><div><p className="eyebrow">SAVED SOURCES</p><h2 id="source-heading">Plan inputs</h2></div><span className="version-tag">Import version {plan.importVersion}</span></div>
            <div className="source-grid">
              {imports.map(({ kind, title }) => {
                const source = latest[kind];
                return <div className="source-item" key={kind}><strong>{title}</strong>{source ? <><span>{source.exportId ?? source.sourceName} · {source.rowCount} rows</span><small>{kind === "stock" && source.checkedAt ? `Count checked ${showDate(source.checkedAt)}` : `Imported ${showDate(source.importedAt)}`}</small></> : <span>Not imported</span>}</div>;
              })}
              <div className="source-item source-crm"><strong>Planning window</strong><span>{showDay(plan.planningWindow.start, plan.planningWindow.timezone)}–{showDay(plan.planningWindow.end, plan.planningWindow.timezone)}</span><small>Cutoff {showDate(plan.planningWindow.cutoff)} · CRM export {plan.source.crmExportId ?? "unknown"}</small></div>
            </div>
          </section>

          <div className="dashboard-grid">
            <section className="dashboard-card daily-card" aria-labelledby="daily-heading">
              <div className="dashboard-card-heading"><div><p className="eyebrow">PRODUCTION &amp; DRAFT ROSTER</p><h2 id="daily-heading">Daily plan</h2></div><span className="draft-tag">Roster for manager review</span></div>
              <div className="daily-grid">
                {plan.dailyProduction.map((day) => <article className="daily-item" key={day.date}>
                  <div className="daily-item-heading"><h3>{day.dayName}</h3><time dateTime={day.date}>{showDay(day.date, plan.planningWindow!.timezone)}</time></div>
                  <p className="daily-total"><strong>{day.totalSandwiches.toLocaleString("en-SG")}</strong> sandwiches · {day.labourHours.toLocaleString("en-SG")} labour h</p>
                  <ul className="product-mix">{day.products.map((product) => <li key={product.productId}><span>{product.productName}</span><b>{product.quantity.toLocaleString("en-SG")}</b></li>)}</ul>
                  <p className="coverage-line">{day.roster.assignedProductiveHours} h rostered of {day.roster.requiredLabourHours} h required{day.roster.uncoveredHours ? ` · ${day.roster.uncoveredHours} h uncovered` : " · covered"}{!day.roster.supervisorCovered ? " · supervisor needed" : ""}</p>
                  <ul className="named-shifts">{day.roster.shifts.map((shift) => <li key={shift.staffId}><span>{shift.name}{shift.supervisor ? " · lead" : ""}</span><small>{shift.start}–{shift.end} · {shift.productiveHours} productive h</small></li>)}</ul>
                  {!day.roster.shifts.length && <p className="muted-note">No roster shifts required for this day.</p>}
                </article>)}
              </div>
            </section>

            <section className="dashboard-card purchasing-card" aria-labelledby="purchasing-heading">
              <div className="dashboard-card-heading"><div><p className="eyebrow">STOCK &amp; WHOLE PACKS</p><h2 id="purchasing-heading">Purchasing review</h2></div></div>
              <div className="table-scroll"><table className="plan-table"><thead><tr><th>Ingredient</th><th>Demand</th><th>Usable</th><th>Shortage</th><th>Request</th></tr></thead><tbody>
                {plan.purchasing.items.map((item) => <tr key={item.ingredientId}><th scope="row">{item.name}</th><td>{item.demand.toLocaleString("en-SG")} {item.unit}</td><td>{item.stockMissing ? "Count needed" : `${item.usableStock?.toLocaleString("en-SG")} ${item.unit}`}</td><td>{item.stockMissing ? "—" : `${(item.shortage ?? 0).toLocaleString("en-SG")} ${item.unit}`}</td><td>{item.stockMissing ? "Import count" : (item.packsToRequest ?? 0) > 0 ? `${item.packsToRequest} × ${item.packName} (${item.requestQuantity?.toLocaleString("en-SG")} ${item.unit})` : "No request"}</td></tr>)}
              </tbody></table></div>
              <p className="muted-note">Requested packs do not add to on-hand stock. Review supplier text below; no email is sent from this screen.</p>
            </section>

            <section className="dashboard-card orders-card" aria-labelledby="orders-heading">
              <div className="dashboard-card-heading"><div><p className="eyebrow">CRM BASELINE</p><h2 id="orders-heading">Orders and exceptions</h2></div></div>
              <p className="orders-summary">{plan.orders.eligibleCount} eligible orders are included. {plan.orders.excludedCount} order{plan.orders.excludedCount === 1 ? " is" : "s are"} excluded from baseline production.</p>
              <details className="orders-details"><summary>Eligible order lines ({plan.orders.eligible.length})</summary><div className="table-scroll"><table className="plan-table"><thead><tr><th>Order</th><th>Customer</th><th>Production day</th><th>Product</th><th>Units</th></tr></thead><tbody>
                {plan.orders.eligible.map((order) => <tr key={order.id}><th scope="row">{order.id}</th><td>{order.customer ?? "—"}</td><td>{showDay(order.production_date, plan.planningWindow!.timezone)}</td><td>{plan.weekly!.products.find((product) => product.productId === order.product_id)?.productName ?? order.product_id}</td><td>{order.quantity.toLocaleString("en-SG")}</td></tr>)}
              </tbody></table></div></details>
              {plan.orders.excluded.length > 0 && <div className="exception-list">{plan.orders.excluded.map((order) => <article className="exception-item" key={order.id}><strong>{order.id} · {order.customer ?? "Customer review"}</strong><p>{order.quantity.toLocaleString("en-SG")} {order.product_id} sandwiches for {showDay(order.production_date, plan.planningWindow!.timezone)}.</p><ul>{(order.exclusionReasons ?? []).map((reason) => <li key={reason}>{reason}</li>)}</ul><span>Manager decision required · not in baseline</span></article>)}</div>}
            </section>

            <section className="dashboard-card leave-card" aria-labelledby="leave-heading">
              <div className="dashboard-card-heading"><div><p className="eyebrow">HR EXCEPTIONS</p><h2 id="leave-heading">Leave and coverage</h2></div><span className="draft-tag">{plan.roster.status}</span></div>
              {plan.roster.approvedLeave.length ? <><h3>Approved leave reflected in roster</h3><ul className="exception-bullets">{plan.roster.approvedLeave.map((leave) => <li key={`${leave.staffId}-${leave.date}`}><strong>{showDay(leave.date)} · {leave.staffName}</strong><span>{leave.reason}</span></li>)}</ul></> : <p className="muted-note">No approved leave in the planning week.</p>}
              {plan.roster.pendingLeaveAlerts.length > 0 && <><h3>Pending leave for manager review</h3><ul className="exception-bullets">{plan.roster.pendingLeaveAlerts.map((leave) => <li key={`${leave.staffId}-${leave.date}`}><strong>{showDay(leave.date)} · {leave.staffName}</strong><span>{leave.reason}</span></li>)}</ul></>}
              {plan.weekly.extraPartTimeShiftsToRequest > 0 && <p className="coverage-alert"><strong>Cover request:</strong> {plan.weekly.extraPartTimeShiftsToRequest} additional four-hour part-time shift{plan.weekly.extraPartTimeShiftsToRequest === 1 ? "" : "s"} to request for {plan.weekly.uncoveredLabourHours} uncovered labour hours. No staff member is booked.</p>}
              {plan.roster.supervisorGaps.length > 0 && <p className="coverage-alert">Supervisor cover required: {plan.roster.supervisorGaps.map((date) => showDay(date)).join(", ")}.</p>}
            </section>
          </div>

          <section className="dashboard-card action-card" aria-labelledby="actions-heading">
            <div className="dashboard-card-heading"><div><p className="eyebrow">HUMAN REVIEW REQUIRED</p><h2 id="actions-heading">Dated action list</h2></div><span className="version-tag">{currentAgentRun ? "Includes saved specialist guidance" : "Based on deterministic plan"}</span></div>
            {actionItems.length ? <ol className="action-list">{actionItems.map((item, index) => <li className={`action-item action-${item.type}`} key={`${item.type}-${item.date}-${index}`}><time dateTime={item.date}>{showDay(item.date, plan.planningWindow!.timezone)}</time><div><strong>{item.title}</strong><p>{item.detail}</p></div></li>)}</ol> : <p className="muted-note">No dated actions are required by the current plan.</p>}
          </section>

          <section className="dashboard-card specialist-summary" aria-labelledby="specialist-summary-heading">
            <div className="dashboard-card-heading"><div><p className="eyebrow">SAVED AGENT RECOMMENDATIONS</p><h2 id="specialist-summary-heading">Planning specialists</h2></div>{currentAgentRun && <span className="version-tag">{currentAgentRun.model} · version {currentAgentRun.importVersion}</span>}</div>
            {currentAgentRun ? <div className="specialist-summary-grid"><article><h3>Sales &amp; Production</h3><p>{currentAgentRun.result.agents.sales.summary}</p><p>{currentAgentRun.result.agents.sales.lateExceptionExplanation}</p></article><article><h3>Manpower</h3><p>{currentAgentRun.result.agents.manpower.summary}</p><p>{currentAgentRun.result.agents.manpower.staffingGapExplanation}</p></article><article><h3>Purchasing</h3><p>{currentAgentRun.result.agents.purchasing.summary}</p><p>{currentAgentRun.result.agents.purchasing.shortageExplanation}</p></article></div> : <p className="muted-note">No agent run is saved for the current import version. Once all five imports are available, run specialists below to add recommendations and a handoff trace.</p>}
            <p className="dashboard-source-note">CRM imported {showDate(plan.source.crmImportedAt)} · stock checked {showDate(plan.source.stockCheckedAt)} · planning window {dateFormat.format(new Date(`${plan.planningWindow.start}T12:00:00.000Z`))}–{dateFormat.format(new Date(`${plan.planningWindow.end}T12:00:00.000Z`))} SGT</p>
          </section>
        </> : <div className="dashboard-card empty-plan"><h2>Saved imports are needed</h2><p>{planMessage}</p><p>Missing imports: {plan?.missingImports?.join(", ") || "loading saved import status"}.</p><p>Import the stock count, HR staff, leave, confirmed part-time availability and CRM order export below. No sample plan is shown in their place.</p></div>}
      </section>
      <section className="imports-main">
        <p className="eyebrow">SOURCE DATA</p>
        <h1>Manage planning data.</h1>
        <p className="intro">Files are validated on the server before they are saved. A rejected upload leaves the last accepted plan in place.</p>

        <div className={`connection-status ${isDatabaseReady ? "connected" : "disconnected"}`} role="status">
          <span className="status-dot" aria-hidden="true" />
          <div><strong>{isDatabaseReady ? "Postgres connected" : "Postgres connection needed"}</strong><p>{statusMessage}</p></div>
          <button className="text-button" type="button" onClick={() => void refreshStatus()}>Refresh status</button>
        </div>

        <div className="access-token">
          <label htmlFor="import-token">Import access token <span>(production only)</span></label>
          <input id="import-token" type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Not needed in local development" />
          <p>The token is sent only to this app’s import API. Local development does not require it.</p>
        </div>

        <div className="import-grid">
          {imports.map(({ kind, title, description, accept }) => {
            const saved = latest[kind];
            const result = results[kind];
            const itemErrors = errors[kind] ?? [];
            return (
              <article className="import-card" key={kind}>
                <div className="import-card-heading"><span className="card-index">{String(imports.findIndex((item) => item.kind === kind) + 1).padStart(2, "0")}</span><h2>{title}</h2></div>
                <p className="card-description">{description}</p>
                <label className="file-picker">
                  <span>{files[kind]?.name ?? "Choose file"}</span>
                  <input type="file" accept={accept} onChange={(event) => { const file = event.target.files?.[0]; setFiles((current) => ({ ...current, [kind]: file })); setErrors((current) => ({ ...current, [kind]: [] })); }} />
                </label>
                <button className="upload-button" type="button" disabled={loading !== null} onClick={() => void upload(kind)}>{loading === kind ? "Validating and saving…" : "Validate and import"}</button>
                {result && <div className="import-feedback success" role="status">
                  <strong>{result.duplicate ? "Already imported" : "Import saved"}</strong>
                  <p>{result.import.rowCount} rows · version {result.import.importVersion}{result.import.exportId ? ` · ${result.import.exportId}` : ""}</p>
                  {result.import.checkedAt && <p>Count checked {showDate(result.import.checkedAt)}</p>}
                  {result.import.sourceSystem && <p>Source: {result.import.sourceSystem}</p>}
                  {result.import.exportedAt && <p>Exported {showDate(result.import.exportedAt)}</p>}
                  <p>Imported {showDate(result.import.importedAt)}</p>
                </div>}
                {!result && saved && <div className="saved-summary"><strong>Latest saved import</strong><p>{saved.rowCount} rows · {saved.exportId ?? saved.sourceName}</p><p>Imported {showDate(saved.importedAt)}</p></div>}
                {itemErrors.length > 0 && <div className="import-feedback failure" role="alert"><strong>Not imported</strong><ul>{itemErrors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}</ul></div>}
              </article>
            );
          })}
        </div>
        <p className="workflow-note">Import HR staff first, then leave and availability. Import CRM orders after the stock and HR files.</p>

        <section className="agent-panel" aria-labelledby="agents-heading">
          <div className="agent-panel-heading">
            <div><p className="eyebrow">SPECIALISTS · SERVER SIDE</p><h2 id="agents-heading">Planning recommendations</h2><p>Numbers, roster assignments and stock packs stay controlled by the verified plan. Recommendations run only when you choose the button.</p></div>
            <button className="upload-button agent-run-button" type="button" disabled={agentLoading || !isDatabaseReady || !planningInputsReady} onClick={() => void runPlanningAgents()}>{agentLoading ? "Running specialists…" : "Run planning agents"}</button>
          </div>
          <p className="agent-status" role="status">{agentMessage}</p>
          {agentError && <div className="import-feedback failure" role="alert"><strong>Agent run failed</strong><p>{agentError}</p><p>The deterministic plan is unchanged and remains available.</p></div>}
          {agentRun && <>
            <p className="agent-meta">Model {agentRun.model} · Import version {agentRun.importVersion} · Run {showDate(agentRun.createdAt)}</p>
            <div className="agent-output-grid">
              <article className="agent-output"><h3>Sales &amp; Production</h3><p>{agentRun.result.agents.sales.summary}</p><strong>Late-order exception</strong><p>{agentRun.result.agents.sales.lateExceptionExplanation}</p><strong>Dated production actions</strong><ul>{agentRun.result.agents.sales.productionActions.map((action) => <li key={action.date}><b>{action.date}:</b> {action.focus}</li>)}</ul></article>
              <article className="agent-output"><h3>Manpower</h3><p>{agentRun.result.agents.manpower.summary}</p><p>{agentRun.result.agents.manpower.staffingGapExplanation}</p><strong>Cover requests for manager review</strong>{agentRun.result.agents.manpower.verifiedCoverRequests.length ? <ul>{agentRun.result.agents.manpower.verifiedCoverRequests.map((item) => <li key={item.date}><b>{item.date}:</b> request {item.shiftsToRequest} four-hour part-time shift ({item.uncoveredHours} uncovered hours). {item.rationale}</li>)}</ul> : <p>No additional part-time request is in the verified roster.</p>}</article>
              <article className="agent-output"><h3>Purchasing</h3><p>{agentRun.result.agents.purchasing.summary}</p><p>{agentRun.result.agents.purchasing.shortageExplanation}</p><strong>Supplier draft for review</strong><p>To: {agentRun.result.agents.purchasing.supplierDraft.to}</p><p>Subject: {agentRun.result.agents.purchasing.supplierDraft.subject}</p><pre>{agentRun.result.agents.purchasing.supplierDraft.body}</pre><p className="agent-draft-note">Draft text only. No email was created or sent.</p></article>
            </div>
            <details className="handoff-trace"><summary>Agent handoff trace</summary><ol>{agentRun.result.handoffTrace.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol></details>
          </>}
        </section>
      </section>
      <footer>Imports and planning runs are saved in Postgres. Numeric planning stays deterministic; all actions remain subject to manager review.</footer>
    </main>
  );
}

