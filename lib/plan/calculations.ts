export type RawRecord = Record<string, unknown>;

export interface ScenarioReference {
  timezone: string;
  order_cutoff: string;
  week_start: string;
  week_end: string;
  settings: {
    permanent_shift_start: string;
    permanent_shift_end: string;
    permanent_break_start: string;
    permanent_break_minutes: number;
    permanent_productive_hours: number;
    part_time_productive_hours: number;
    max_shifts_per_person_per_day: number;
  };
}

export interface RecipeReference {
  products: Array<{ id: string; name: string; labour_hours_per_unit: number }>;
  recipes: Array<{ product_id: string; ingredient_id: string; quantity_per_unit: number }>;
}

export interface ImportSource {
  sourceName: string;
  sourceSystem?: string | null;
  exportId?: string | null;
  exportedAt?: Date | string | null;
  checkedAt?: Date | string | null;
  importedAt: Date | string;
  rowCount: number;
  importVersion: number;
}

export interface CalculatePlanInput {
  importVersion: number;
  scenario: ScenarioReference;
  recipes: RecipeReference;
  supplier: RawRecord;
  orders: RawRecord[];
  inventory: RawRecord[];
  staff: RawRecord[];
  leave: RawRecord[];
  availability: RawRecord[];
  sources: Record<string, ImportSource>;
}

export class PlanCalculationError extends Error {
  constructor(message: string) { super(message); this.name = "PlanCalculationError"; }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new PlanCalculationError(`${label} is missing or invalid.`);
  return value;
}

function number(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new PlanCalculationError(`${label} is not numeric.`);
  return parsed;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function dateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime()) || cursor > last) throw new PlanCalculationError("The planning week dates are invalid.");
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function dayName(date: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-SG", { weekday: "long", timeZone: timezone }).format(new Date(`${date}T00:00:00.000Z`));
}

function staffHasSkill(person: RawRecord, skill: string): boolean {
  return Array.isArray(person.skills) && person.skills.some((entry) => typeof entry === "string" && entry.toLowerCase() === skill);
}

function byWeeklyHoursThenName(a: RawRecord, b: RawRecord, assignedHours: Map<string, number>): number {
  const hoursDifference = (assignedHours.get(String(a.id)) ?? 0) - (assignedHours.get(String(b.id)) ?? 0);
  return hoursDifference || text(a.name, "Staff name").localeCompare(text(b.name, "Staff name"), "en");
}

interface DailyAccumulator {
  date: string;
  dayName: string;
  productUnits: Map<string, number>;
  ingredientDemand: Map<string, number>;
  labourHours: number;
}

export function calculatePlan(input: CalculatePlanInput) {
  const { scenario, recipes } = input;
  const cutoff = Date.parse(scenario.order_cutoff);
  if (!Number.isFinite(cutoff)) throw new PlanCalculationError("The order cutoff is invalid.");
  const productById = new Map(recipes.products.map((product) => [product.id, product]));
  const recipesByProduct = new Map<string, typeof recipes.recipes>();
  for (const recipe of recipes.recipes) {
    const group = recipesByProduct.get(recipe.product_id) ?? [];
    group.push(recipe);
    recipesByProduct.set(recipe.product_id, group);
  }
  for (const product of recipes.products) if (!recipesByProduct.has(product.id)) throw new PlanCalculationError(`No recipe exists for ${product.id}.`);

  const eligibleOrders: Array<RawRecord & { quantity: number; receivedAt: string }> = [];
  const excludedOrders: Array<RawRecord & { quantity: number; exclusionReasons: string[] }> = [];
  const dailyDates = dateRange(scenario.week_start, scenario.week_end);
  const dailyByDate = new Map<string, DailyAccumulator>(dailyDates.map((date) => [date, {
    date,
    dayName: dayName(date, scenario.timezone),
    productUnits: new Map<string, number>(),
    ingredientDemand: new Map<string, number>(),
    labourHours: 0,
  }]));

  for (const order of input.orders) {
    const id = text(order.id, "Order ID");
    const productId = text(order.product_id, `Order ${id} product`);
    const product = productById.get(productId);
    if (!product) throw new PlanCalculationError(`Order ${id} uses unknown product ${productId}.`);
    const quantity = number(order.quantity, `Order ${id} quantity`);
    const productionDate = text(order.production_date, `Order ${id} production date`);
    const receivedAt = text(order.received_at, `Order ${id} received_at`);
    const reasons: string[] = [];
    if (order.status !== "Confirmed") reasons.push(`Status is ${String(order.status ?? "missing")}; only confirmed orders are planned.`);
    if (productionDate < scenario.week_start || productionDate > scenario.week_end) reasons.push(`Production date is outside ${scenario.week_start} to ${scenario.week_end}.`);
    if (!Number.isFinite(Date.parse(receivedAt))) throw new PlanCalculationError(`Order ${id} has an invalid received_at timestamp.`);
    if (Date.parse(receivedAt) > cutoff) reasons.push(`Received after the cutoff at ${scenario.order_cutoff}.`);
    if (reasons.length) {
      excludedOrders.push({ ...order, quantity, exclusionReasons: reasons });
      continue;
    }
    const day = dailyByDate.get(productionDate);
    if (!day) throw new PlanCalculationError(`Order ${id} has a production date outside the configured week.`);
    eligibleOrders.push({ ...order, quantity, receivedAt });
    day.productUnits.set(productId, (day.productUnits.get(productId) ?? 0) + quantity);
    day.labourHours += quantity * number(product.labour_hours_per_unit, `${productId} labour rate`);
    for (const recipe of recipesByProduct.get(productId) ?? []) {
      day.ingredientDemand.set(recipe.ingredient_id, (day.ingredientDemand.get(recipe.ingredient_id) ?? 0) + quantity * number(recipe.quantity_per_unit, `${productId} recipe quantity`));
    }
  }

  const weeklyProductUnits = new Map<string, number>();
  const weeklyIngredientDemand = new Map<string, number>();
  for (const day of dailyByDate.values()) {
    for (const [productId, quantity] of day.productUnits) weeklyProductUnits.set(productId, (weeklyProductUnits.get(productId) ?? 0) + quantity);
    for (const [ingredientId, quantity] of day.ingredientDemand) weeklyIngredientDemand.set(ingredientId, (weeklyIngredientDemand.get(ingredientId) ?? 0) + quantity);
  }

  const inventoryById = new Map(input.inventory.map((row) => [text(row.ingredient_id, "Inventory ingredient_id"), row]));
  const demandIngredientIds = new Set(weeklyIngredientDemand.keys());
  const allIngredientIds = [...new Set([...input.inventory.map((row) => text(row.ingredient_id, "Inventory ingredient_id")), ...demandIngredientIds])];
  const ingredientPurchasing = allIngredientIds.map((ingredientId) => {
    const stock = inventoryById.get(ingredientId);
    const demand = weeklyIngredientDemand.get(ingredientId) ?? 0;
    const name = stock && typeof stock.name === "string" ? stock.name : ingredientId;
    const unit = stock && typeof stock.unit === "string" ? stock.unit : "unknown";
    if (!stock) return { ingredientId, name, unit, demand: round(demand), stockMissing: true, onHand: null, committed: null, usableStock: null, shortage: null, packSize: null, packName: null, packsToRequest: null, requestQuantity: null };
    const onHand = number(stock.on_hand, `${ingredientId} on_hand`);
    const committed = number(stock.committed, `${ingredientId} committed`);
    const packSize = number(stock.pack_size, `${ingredientId} pack_size`);
    if (packSize <= 0) throw new PlanCalculationError(`${ingredientId} pack size must be positive.`);
    const usableStock = onHand - committed;
    const shortage = Math.max(0, demand - usableStock);
    const packsToRequest = shortage > 0 ? Math.ceil(shortage / packSize) : 0;
    return {
      ingredientId,
      name,
      unit,
      demand: round(demand),
      stockMissing: false,
      onHand: round(onHand),
      committed: round(committed),
      usableStock: round(usableStock),
      shortage: round(shortage),
      packSize: round(packSize),
      packName: typeof stock.pack_name === "string" ? stock.pack_name : "supplier pack",
      packsToRequest,
      requestQuantity: round(packsToRequest * packSize),
    };
  });

  const approvedLeaveKeys = new Set(input.leave
    .filter((entry) => entry.status === "Approved")
    .map((entry) => `${String(entry.staff_id)}:${String(entry.date)}`));
  const approvedLeave = input.leave
    .filter((entry) => entry.status === "Approved" && dailyByDate.has(String(entry.date)))
    .map((entry) => ({ staffId: String(entry.staff_id), staffName: input.staff.find((person) => person.id === entry.staff_id)?.name ?? String(entry.staff_id), date: String(entry.date), reason: typeof entry.reason === "string" ? entry.reason : "Approved leave" }));
  const pendingLeaveAlerts = input.leave
    .filter((entry) => entry.status === "Pending" && dailyByDate.has(String(entry.date)))
    .map((entry) => ({ staffId: String(entry.staff_id), staffName: input.staff.find((person) => person.id === entry.staff_id)?.name ?? String(entry.staff_id), date: String(entry.date), reason: typeof entry.reason === "string" ? entry.reason : "Pending leave requires manager review" }));

  const productionStaff = input.staff.filter((person) => staffHasSkill(person, "production"));
  const weeklyAssignedHours = new Map(productionStaff.map((person) => [text(person.id, "Staff ID"), 0]));
  const rosteredDays = [...dailyByDate.values()].map((day) => {
    const assignedToday = new Set<string>();
    const shifts: Array<{ staffId: string; name: string; role: string; employmentType: string; start: string; end: string; productiveHours: number; supervisor: boolean }> = [];
    let assignedHours = 0;
    const demandHours = round(day.labourHours);
    const canWorkToday = (person: RawRecord) => !approvedLeaveKeys.has(`${String(person.id)}:${day.date}`) && !assignedToday.has(String(person.id));
    const addShift = (person: RawRecord, start: string, end: string, productiveHours: number) => {
      const id = text(person.id, "Staff ID");
      if (assignedToday.has(id)) throw new PlanCalculationError(`${id} was assigned more than one shift on ${day.date}.`);
      assignedToday.add(id);
      const isSupervisor = person.role === "Kitchen lead" && staffHasSkill(person, "supervisor");
      const name = text(person.name, "Staff name");
      shifts.push({ staffId: id, name, role: text(person.role, "Staff role"), employmentType: text(person.employment_type, "Employment type"), start, end, productiveHours, supervisor: isSupervisor });
      assignedHours += productiveHours;
      weeklyAssignedHours.set(id, (weeklyAssignedHours.get(id) ?? 0) + productiveHours);
    };
    const permanent = productionStaff.filter((person) => person.employment_type === "Permanent" && canWorkToday(person));
    const supervisors = permanent.filter((person) => person.role === "Kitchen lead" && staffHasSkill(person, "supervisor")).sort((a, b) => byWeeklyHoursThenName(a, b, weeklyAssignedHours));
    const supervisor = demandHours > 0 ? supervisors[0] : undefined;
    if (supervisor) addShift(supervisor, scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end, scenario.settings.permanent_productive_hours);

    while (assignedHours < demandHours) {
      const nextPermanent = permanent.filter(canWorkToday).sort((a, b) => byWeeklyHoursThenName(a, b, weeklyAssignedHours))[0];
      if (!nextPermanent) break;
      addShift(nextPermanent, scenario.settings.permanent_shift_start, scenario.settings.permanent_shift_end, scenario.settings.permanent_productive_hours);
    }

    if (assignedHours < demandHours) {
      const availablePartTimers = input.availability
        .filter((entry) => entry.date === day.date && entry.status === "Confirmed")
        .map((entry) => ({ entry, person: input.staff.find((candidate) => candidate.id === entry.staff_id) }))
        .filter((value): value is { entry: RawRecord; person: RawRecord } => !!value.person && value.person.employment_type === "Part-time" && staffHasSkill(value.person, "production") && canWorkToday(value.person))
        .sort((a, b) => byWeeklyHoursThenName(a.person, b.person, weeklyAssignedHours));
      for (const available of availablePartTimers) {
        if (assignedHours >= demandHours) break;
        addShift(available.person, text(available.entry.start, "Availability start"), text(available.entry.end, "Availability end"), scenario.settings.part_time_productive_hours);
      }
    }

    const uncoveredHours = round(Math.max(0, demandHours - assignedHours));
    const extraPartTimeShiftsToRequest = uncoveredHours > 0 ? Math.ceil(uncoveredHours / scenario.settings.part_time_productive_hours) : 0;
    return {
      date: day.date,
      dayName: day.dayName,
      requiredLabourHours: demandHours,
      assignedProductiveHours: round(assignedHours),
      uncoveredHours,
      surplusHours: round(Math.max(0, assignedHours - demandHours)),
      extraPartTimeShiftsToRequest,
      supervisorRequired: demandHours > 0,
      supervisorCovered: demandHours === 0 || shifts.some((shift) => shift.supervisor),
      shifts,
    };
  });

  const dailyProduction = [...dailyByDate.values()].map((day) => {
    const productQuantities = recipes.products
      .map((product) => ({ productId: product.id, productName: product.name, quantity: day.productUnits.get(product.id) ?? 0, labourHours: round((day.productUnits.get(product.id) ?? 0) * product.labour_hours_per_unit) }))
      .filter((product) => product.quantity > 0);
    const ingredientQuantities = [...day.ingredientDemand.entries()].map(([ingredientId, quantity]) => {
      const stock = inventoryById.get(ingredientId);
      return { ingredientId, name: typeof stock?.name === "string" ? stock.name : ingredientId, unit: typeof stock?.unit === "string" ? stock.unit : "unknown", quantity: round(quantity) };
    });
    const roster = rosteredDays.find((value) => value.date === day.date)!;
    return {
      date: day.date,
      dayName: day.dayName,
      totalSandwiches: productQuantities.reduce((sum, product) => sum + product.quantity, 0),
      labourHours: round(day.labourHours),
      products: productQuantities,
      ingredients: ingredientQuantities,
      roster,
    };
  });

  const totalLabourHours = round(dailyProduction.reduce((sum, day) => sum + day.labourHours, 0));
  const totalSandwiches = eligibleOrders.reduce((sum, order) => sum + order.quantity, 0);
  const rosteredProductiveHours = round(rosteredDays.reduce((sum, day) => sum + day.assignedProductiveHours, 0));
  const uncoveredHours = round(rosteredDays.reduce((sum, day) => sum + day.uncoveredHours, 0));
  const extraPartTimeShiftsToRequest = rosteredDays.reduce((sum, day) => sum + day.extraPartTimeShiftsToRequest, 0);
  const weeklyProducts = recipes.products
    .map((product) => ({ productId: product.id, productName: product.name, quantity: weeklyProductUnits.get(product.id) ?? 0, labourHours: round((weeklyProductUnits.get(product.id) ?? 0) * product.labour_hours_per_unit) }))
    .filter((product) => product.quantity > 0);

  return {
    ready: true as const,
    importVersion: input.importVersion,
    planningWindow: { timezone: scenario.timezone, cutoff: scenario.order_cutoff, start: scenario.week_start, end: scenario.week_end },
    source: {
      crmExportId: input.sources.crm_orders?.exportId ?? null,
      crmImportedAt: input.sources.crm_orders?.importedAt ?? null,
      stockCheckedAt: input.sources.stock?.checkedAt ?? null,
    },
    orders: {
      eligibleCount: eligibleOrders.length,
      excludedCount: excludedOrders.length,
      eligible: eligibleOrders,
      excluded: excludedOrders,
    },
    weekly: {
      totalSandwiches,
      totalLabourHours,
      products: weeklyProducts,
      ingredients: [...weeklyIngredientDemand.entries()].map(([ingredientId, quantity]) => {
        const stock = inventoryById.get(ingredientId);
        return { ingredientId, name: typeof stock?.name === "string" ? stock.name : ingredientId, unit: typeof stock?.unit === "string" ? stock.unit : "unknown", quantity: round(quantity) };
      }),
      assignedProductiveHours: rosteredProductiveHours,
      uncoveredLabourHours: uncoveredHours,
      extraPartTimeShiftsToRequest,
    },
    dailyProduction,
    purchasing: {
      supplier: input.supplier,
      items: ingredientPurchasing,
      missingInventoryIngredients: ingredientPurchasing.filter((item) => item.stockMissing).map((item) => item.ingredientId),
    },
    roster: {
      status: "draft for manager review",
      daily: rosteredDays,
      weeklyHoursByStaff: [...weeklyAssignedHours.entries()].map(([staffId, hours]) => ({ staffId, name: input.staff.find((person) => person.id === staffId)?.name ?? staffId, productiveHours: round(hours) })).filter((person) => person.productiveHours > 0),
      approvedLeave,
      pendingLeaveAlerts,
      supervisorGaps: rosteredDays.filter((day) => day.supervisorRequired && !day.supervisorCovered).map((day) => day.date),
    },
  };
}

