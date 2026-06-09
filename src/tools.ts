import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AbrpClient, AbrpError } from "./abrp.js";

/** Render any tool result as MCP text content. */
function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown) {
  const detail =
    error instanceof AbrpError
      ? { status: error.status, body: error.body }
      : { message: error instanceof Error ? error.message : String(error) };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: `ABRP request failed:\n${JSON.stringify(detail, null, 2)}` }],
  };
}

/** Wrap a tool handler so thrown ABRP/network errors become MCP error results. */
function handler<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

/**
 * The /plan response embeds huge per-point geometry — encoded polylines, the
 * per-point SoC/speed/elevation arrays in `geometryPointInfo`, turn-by-turn
 * `instructions`, `speedLimits` — which can push a single international route
 * well past an MCP client's payload cap (Claude rejects tool results over 1 MB).
 * ABRP has no server-side toggle to omit it (ResultOptions only covers
 * alternatives/currency/unitSystem), and an LLM doesn't use any of it: it needs
 * the summary and the charging stops. So strip the heavy fields by default and
 * keep them only when the caller explicitly asks for `detail: "full"`.
 */
export function slimPlan(result: unknown): unknown {
  if (!result || typeof result !== "object") return result;
  const r = result as Record<string, unknown>;
  if (!Array.isArray(r.routes)) return result;
  return {
    ...r,
    routes: r.routes.map((rt) => {
      if (!rt || typeof rt !== "object") return rt;
      const route = rt as Record<string, unknown>;
      const cost = routeCost(route);
      return {
        ...route,
        ...(cost ? { estimatedChargingCost: cost } : {}),
        legs: Array.isArray(route.legs) ? route.legs.map(slimLeg) : route.legs,
      };
    }),
  };
}

/** Sum the per-stop charging costs ABRP returns into a single trip total. */
export function routeCost(route: Record<string, unknown>): { amount: number; currency: string } | undefined {
  const legs = route.legs;
  if (!Array.isArray(legs)) return undefined;
  let total = 0;
  let currency: string | undefined;
  let any = false;
  for (const leg of legs) {
    const costs = (leg as { origin?: { charger?: { costs?: unknown } } })?.origin?.charger?.costs;
    if (!Array.isArray(costs) || costs.length === 0) continue;
    const entry =
      (costs.find((c) => (c as { isDefault?: boolean })?.isDefault) as Record<string, unknown>) ??
      (costs[0] as Record<string, unknown>);
    if (entry && typeof entry.cost === "number") {
      total += entry.cost;
      if (typeof entry.currency === "string") currency = entry.currency;
      any = true;
    }
  }
  return any ? { amount: Math.round(total * 100) / 100, currency: currency ?? "" } : undefined;
}

function slimLeg(leg: unknown): unknown {
  if (!leg || typeof leg !== "object") return leg;
  const out = { ...(leg as Record<string, unknown>) };
  const origin = out.origin;
  if (origin && typeof origin === "object") {
    // Keep the stop facts; drop the bulky per-charger power curve.
    const { chargeProfile, ...rest } = origin as Record<string, unknown>;
    void chargeProfile;
    out.origin = rest;
  }
  const drive = out.driveDetails;
  if (drive && typeof drive === "object") {
    const d = drive as Record<string, unknown>;
    // Keep the useful scalars; replace the giant geometry arrays with counts.
    out.driveDetails = {
      durationSec: d.durationSec,
      driveDistanceM: d.driveDistanceM,
      consumedSoc: d.consumedSoc,
      consumedW: d.consumedW,
      instructionCount: Array.isArray(d.instructions) ? d.instructions.length : undefined,
    };
  }
  return out;
}

/** Attach a browser-viewable ABRP link built from the plan's persisted id. */
function withViewUrl(result: unknown): unknown {
  if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.planId === "string") {
      return { viewUrl: `https://abetterrouteplanner.com/?plan_uuid=${r.planId}`, ...r };
    }
  }
  return result;
}

// Process-lifetime cache of the (rarely-changing) car-model catalogue.
let carModelsCache: { at: number; models: Array<{ name: string; typecode: string }> } | null = null;

async function getCarModels(client: AbrpClient) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (carModelsCache && Date.now() - carModelsCache.at < SIX_HOURS) return carModelsCache.models;
  const models = await client.listCarModels();
  // Don't cache an empty/failed result — a transient blip would otherwise make
  // find_vehicle return "0 models" for six hours.
  if (models.length > 0) carModelsCache = { at: Date.now(), models };
  return models;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A naive clock for the trip, computed in UTC so the server timezone never leaks. */
function tripClock(departDate: string, dayIndex: number, departMinutes: number) {
  const base = new Date(`${departDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + dayIndex);
  base.setUTCMinutes(departMinutes);
  return base;
}

const fmtDate = (d: Date) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
const fmtTime = (d: Date) =>
  `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;

/**
 * Split a plan's single best route into daily driving legs under a per-day
 * drive-time cap, ending each day at a charger town (a natural overnight stop).
 * When `departDate` is given, also assigns each day a date and clock times,
 * departing every morning at `dailyDepartTime`. Returns structured days plus a
 * human-readable itinerary string.
 */
export function summarizeTrip(
  result: unknown,
  opts: { maxDriveHoursPerDay: number; departDate?: string; dailyDepartTime: string },
) {
  const { maxDriveHoursPerDay, departDate, dailyDepartTime } = opts;
  const route = (result as { routes?: Array<Record<string, unknown>> })?.routes?.[0];
  const legs = (route?.legs as Array<Record<string, unknown>>) ?? [];
  const planId = (result as { planId?: string })?.planId;
  if (!legs.length) return result;

  const capSec = maxDriveHoursPerDay * 3600;
  const [dh, dm] = dailyDepartTime.split(":").map(Number);
  const departMinutes = (dh ?? 9) * 60 + (dm ?? 0);
  const name = (o: Record<string, unknown>) =>
    typeof o.name === "string" && o.name ? o.name : `${o.lat},${o.long}`;

  type Day = {
    from: string;
    to: string;
    driveHours: number;
    chargeHours: number;
    distanceKm: number;
    chargeStops: number;
    date?: string;
    depart?: string;
    arrive?: string;
  };
  const days: Day[] = [];
  let dayStart = legs[0]!.origin as Record<string, unknown>;
  let driveSec = 0;
  let chargeSec = 0;
  let distM = 0;
  let stops = 0;

  const closeDay = (to: Record<string, unknown>) => {
    const day: Day = {
      from: name(dayStart),
      to: name(to),
      driveHours: Math.round((driveSec / 3600) * 10) / 10,
      chargeHours: Math.round((chargeSec / 3600) * 10) / 10,
      distanceKm: Math.round(distM / 1000),
      chargeStops: stops,
    };
    if (departDate) {
      const depart = tripClock(departDate, days.length, departMinutes);
      const arrive = new Date(depart.getTime() + (driveSec + chargeSec) * 1000);
      day.date = fmtDate(depart);
      day.depart = fmtTime(depart);
      day.arrive = fmtTime(arrive);
    }
    days.push(day);
    dayStart = to;
    driveSec = 0;
    chargeSec = 0;
    distM = 0;
    stops = 0;
  };

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!;
    const drive = leg.driveDetails as Record<string, number> | undefined;
    const legDrive = drive?.durationSec ?? 0;
    const origin = leg.origin as Record<string, unknown>;
    // Close the day before a leg that would push us over the drive cap.
    if (driveSec > 0 && driveSec + legDrive > capSec) closeDay(origin);
    driveSec += legDrive;
    distM += drive?.driveDistanceM ?? 0;
    if (origin.type === "ADDED_CHARGER") {
      stops++;
      chargeSec += (origin.totalStayDurationSec as number) ?? 0;
    }
  }
  // Final day ends at the route's last origin (the destination).
  closeDay(legs[legs.length - 1]!.origin as Record<string, unknown>);

  const totalKm = days.reduce((s, d) => s + d.distanceKm, 0);
  const totalH = Math.round(days.reduce((s, d) => s + d.driveHours, 0) * 10) / 10;
  const cost = routeCost(route as Record<string, unknown>);
  const costStr = cost ? ` · ~${cost.amount} ${cost.currency} charging` : "";
  const header = departDate
    ? `${totalKm} km · ${totalH} h driving · ${days.length} day(s), depart ${dailyDepartTime} daily (times local/CET)${costStr}`
    : `${totalKm} km · ${totalH} h driving · ${days.length} day(s) (max ${maxDriveHoursPerDay} h/day)${costStr}`;
  const itinerary = [
    header,
    ...days.map((d, i) => {
      const when = d.date ? `${d.date}, ${d.depart}–${d.arrive}  ` : "";
      return `  Day ${i + 1}: ${when}${d.from} → ${d.to} — ${d.driveHours} h drive + ${d.chargeHours} h charging, ${d.distanceKm} km, ${d.chargeStops} stop(s)`;
    }),
  ].join("\n");

  return {
    days,
    summary: {
      totalKm,
      totalDriveHours: totalH,
      dayCount: days.length,
      maxDriveHoursPerDay,
      ...(cost ? { estimatedChargingCost: cost } : {}),
    },
    itinerary,
    ...(planId ? { viewUrl: `https://abetterrouteplanner.com/?plan_uuid=${planId}`, planId } : {}),
  };
}

// --- Shared input shapes ----------------------------------------------------

const destinationSchema = z
  .object({
    lat: z.number().optional().describe("Latitude (use with `long` for a coordinate stop)."),
    long: z.number().optional().describe("Longitude (use with `lat`)."),
    address: z.string().optional().describe("Free-text address; geocoded by ABRP. Alternative to lat/long."),
    chargerId: z
      .number()
      .int()
      .optional()
      .describe("ABRP charger id to route through. Alternative to lat/long."),
    name: z.string().optional().describe("Display name, echoed back in the result (e.g. 'Home')."),
    minArrivalSocFrac: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Minimum state-of-charge (0–1) required on arrival at this stop."),
  })
  .describe("A waypoint: coordinate (lat/long), address, or chargerId.");

type DestinationInput = z.infer<typeof destinationSchema>;

/** Convert a friendly destination into the API's discriminated `Destination`. */
export function toApiDestination(d: DestinationInput) {
  let location: Record<string, unknown>;
  if (d.lat !== undefined && d.long !== undefined) {
    location = { type: "COORDINATES", lat: d.lat, long: d.long };
  } else if (d.address) {
    location = { type: "ADDRESS", value: d.address };
  } else if (d.chargerId !== undefined) {
    location = { type: "CHARGER_ID", value: d.chargerId };
  } else {
    throw new AbrpError("Each destination needs lat+long, address, or chargerId.", 400, {
      message: "invalid_destination",
    });
  }
  return {
    location,
    ...(d.name ? { name: d.name } : {}),
    ...(d.minArrivalSocFrac !== undefined
      ? { energySettings: { minArrivalSocFrac: d.minArrivalSocFrac } }
      : {}),
  };
}

const chargingSchema = z
  .object({
    connectorTypes: z
      .array(z.string())
      .optional()
      .describe(
        "Allowed connectors, e.g. ['CCS','NACS']. CCS, NACS, TESLA_CCS, CHADEMO, TYPE2, GBT, J1772, …",
      ),
    minimumDestinationSocFrac: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Min SoC at final destination (default 0.1)."),
    minimumChargerArrivalSocFrac: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe("Min SoC arriving at any charger/waypoint (default 0.1)."),
    maximumChargingSocFrac: z
      .number()
      .min(0.2)
      .max(1)
      .optional()
      .describe("Cap the charge level (default 1.0)."),
    overheadSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Per-stop overhead in seconds for find/plug/start (default 300). Higher → fewer, longer stops.",
      ),
    stopPreference: z
      .enum(["MOST", "MORE", "OPTIMAL", "FEWER", "FEWEST"])
      .optional()
      .describe("Bias the number of charge stops (default OPTIMAL = shortest total time)."),
    realTimeStatus: z
      .boolean()
      .optional()
      .describe("Plan with live charger availability (premium; must be enabled on the key)."),
    excludedChargerIds: z
      .array(z.number().int())
      .optional()
      .describe("Charger ids to exclude from the plan."),
    preferredMinimumStallCount: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Soft preference for a minimum stall count per charger."),
    preferredFeatures: z
      .array(
        z.enum([
          "TRAILER_FRIENDLY",
          "DOG_FRIENDLY",
          "HAS_PLAYGROUND",
          "HAS_OPEN_RESTROOMS",
          "PLUG_AND_CHARGE",
        ]),
      )
      .optional()
      .describe(
        "Bias toward chargers with these amenities (soft preference, not a hard filter). TRAILER_FRIENDLY = caravan/trailer-accessible (pull-through), HAS_PLAYGROUND, HAS_OPEN_RESTROOMS, DOG_FRIENDLY, PLUG_AND_CHARGE.",
      ),
    preferredTags: z
      .array(z.string())
      .optional()
      .describe(
        "Bias toward chargers carrying these free-text tags (e.g. for food/restaurant nearby), soft preference.",
      ),
    networks: z
      .array(
        z.object({
          id: z.number().int().describe("Network id (look up with abrp_search_networks)."),
          preference: z
            .enum(["EXCLUDE", "DISLIKE", "NO_PREFERENCE", "PREFER", "PREFER_STRONGLY", "EXCLUSIVE"])
            .describe("EXCLUSIVE = plan only on these networks; EXCLUDE = never use."),
        }),
      )
      .optional()
      .describe(
        "Per-network preferences, e.g. only Ionity/Tesla, or avoid a network. Resolve ids via abrp_search_networks.",
      ),
  })
  .describe("Charging constraints/preferences.");

/** Map the friendly charging schema onto the API's ChargingOptions shape. */
export function toApiCharging(charging?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!charging) return undefined;
  const { preferredFeatures, preferredTags, networks, ...rest } = charging as {
    preferredFeatures?: string[];
    preferredTags?: string[];
    networks?: Array<{ id: number; preference: string }>;
  } & Record<string, unknown>;
  return {
    ...rest,
    ...(preferredFeatures?.length
      ? { featurePreferences: preferredFeatures.map((feature) => ({ feature, preference: "PREFER" })) }
      : {}),
    ...(preferredTags?.length
      ? { tagPreferences: preferredTags.map((tag) => ({ tag, preference: "PREFER" })) }
      : {}),
    ...(networks?.length ? { networkPreferences: networks } : {}),
  };
}

const weatherSchema = z
  .object({
    type: z
      .enum(["SEASONAL", "REAL_TIME", "MANUAL"])
      .describe(
        "SEASONAL = seasonal average (default); REAL_TIME = live conditions; MANUAL = set values below.",
      ),
    temperatureC: z.number().optional().describe("MANUAL: outside temperature in °C (affects consumption)."),
    roadConditions: z.enum(["NORMAL", "RAIN", "HEAVY_RAIN"]).optional().describe("MANUAL: road conditions."),
    windSpeedMs: z.number().min(0).optional().describe("MANUAL: wind speed in m/s."),
    windDirection: z.enum(["HEAD", "TAIL"]).optional().describe("MANUAL: head- or tail-wind."),
  })
  .describe("Weather assumptions — strongly affects range (cold/heat/wind).");

/** Build the API resultOptions block from friendly currency/units/alternatives. */
function toResultOptions(opts: {
  currency?: string;
  units?: "METRIC" | "IMPERIAL";
  alternatives?: boolean;
}): Record<string, unknown> | undefined {
  const r: Record<string, unknown> = {};
  if (opts.currency) r.currency = opts.currency;
  if (opts.units) r.unitSystem = opts.units;
  if (opts.alternatives) r.alternatives = { type: "ROUTES" };
  return Object.keys(r).length ? r : undefined;
}

const speedSchema = z
  .object({
    maximumMs: z
      .number()
      .min(0)
      .optional()
      .describe("Max planning speed in m/s, even if limits allow more (e.g. Autobahn cap)."),
    allowAdjustment: z
      .boolean()
      .optional()
      .describe("Let the planner slow individual legs to reach the next charger (default false)."),
    scaling: z.number().min(0).optional().describe("Speed factor vs limits; 1.1 = 10% faster (default 1)."),
  })
  .describe("Speed options.");

const avoidSchema = z
  .object({
    ferries: z.boolean().optional(),
    highways: z.boolean().optional(),
    tolls: z.boolean().optional(),
    borders: z
      .boolean()
      .optional()
      .describe("If true, no country border crossings (chargers/waypoints stay in-country)."),
  })
  .describe("Route avoidance options.");

/**
 * Register every ABRP tool on the MCP server.
 *
 * `getClient` is called per invocation so credentials can come from the request
 * context (OAuth token / headers) or an env fallback.
 */
export function registerAbrpTools(server: McpServer, getClient: () => AbrpClient) {
  // --- Diagnostics ---------------------------------------------------------
  server.registerTool(
    "abrp_check_access",
    {
      title: "Check API access",
      description:
        "Verify the configured ABRP Planning API key works by calling a free reference-consumption endpoint. Returns the result on success.",
      inputSchema: {
        typecode: z
          .string()
          .optional()
          .describe("Vehicle typecode to probe (default a public model). Format make:model:year:battery."),
      },
    },
    handler(async ({ typecode }: { typecode?: string }) => getClient().checkAccess(typecode)),
  );

  // --- Route planning (the headline feature, billed) -----------------------
  server.registerTool(
    "abrp_plan_route",
    {
      title: "Plan an EV route",
      description:
        "Plan an EV route with charging stops. Returns up to 3 alternative routes, each with a summary and charging stops (arrival/departure SoC, charge duration, power). By default the bulky map geometry (polylines, per-point arrays, turn-by-turn) is stripped so the result fits within MCP size limits — pass detail:'full' if you truly need it. NOTE: each successful plan is billed by Iternio. Supply at least an origin and destination plus the vehicle typecode.",
      inputSchema: {
        destinations: z
          .array(destinationSchema)
          .min(2)
          .describe("Ordered stops; first = origin, last = final destination. At least 2."),
        typecode: z
          .string()
          .describe(
            "Vehicle model typecode, e.g. 'rivian:r1s:21:135' (make:model:year:battery). Use abrp_list_vehicles to find one.",
          ),
        currentSocFrac: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Current state of charge as a fraction 0–1 (default 0.9)."),
        referenceConsumption: z
          .number()
          .min(0)
          .max(1000)
          .optional()
          .describe("Override reference consumption in Wh/km."),
        degradationFrac: z.number().min(0).max(1).optional().describe("Battery degradation fraction 0–1."),
        configuration: z.string().optional().describe("Consumption modifier, e.g. 'trailer'."),
        charging: chargingSchema.optional(),
        speed: speedSchema.optional(),
        avoid: avoidSchema.optional(),
        weather: weatherSchema.optional(),
        traffic: z
          .enum(["NO_TRAFFIC", "REAL_TIME"])
          .optional()
          .describe("REAL_TIME uses live traffic (premium on the key)."),
        currency: z
          .string()
          .length(3)
          .optional()
          .describe("3-letter currency for charging costs, e.g. 'DKK', 'EUR'."),
        units: z.enum(["METRIC", "IMPERIAL"]).optional().describe("Units in the response (default METRIC)."),
        alternatives: z
          .boolean()
          .optional()
          .describe("Return up to ~3 alternative routes instead of just the best one."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Advanced: extra top-level PlanRequest fields merged verbatim (clientContext, etc.)."),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "Response detail. 'summary' (default) returns the route summary and charging stops with the bulky map geometry stripped — use this. 'full' returns the complete response including polylines and per-point arrays, which can exceed an MCP client's size limit on long routes.",
          ),
      },
    },
    handler(
      async (args: {
        destinations: DestinationInput[];
        typecode: string;
        currentSocFrac?: number;
        referenceConsumption?: number;
        degradationFrac?: number;
        configuration?: string;
        charging?: Record<string, unknown>;
        speed?: Record<string, unknown>;
        avoid?: Record<string, unknown>;
        weather?: Record<string, unknown>;
        traffic?: string;
        currency?: string;
        units?: "METRIC" | "IMPERIAL";
        alternatives?: boolean;
        extra?: Record<string, unknown>;
        detail?: "summary" | "full";
      }) => {
        const resultOptions = toResultOptions(args);
        const request: Record<string, unknown> = {
          destinations: args.destinations.map(toApiDestination),
          vehicle: {
            identifier: { type: "TYPECODE", value: args.typecode },
            ...(args.currentSocFrac !== undefined ? { currentSocFrac: args.currentSocFrac } : {}),
            ...(args.referenceConsumption !== undefined
              ? { referenceConsumption: args.referenceConsumption }
              : {}),
            ...(args.degradationFrac !== undefined ? { degradationFrac: args.degradationFrac } : {}),
            ...(args.configuration ? { configuration: args.configuration } : {}),
          },
          ...(args.charging ? { charging: toApiCharging(args.charging) } : {}),
          ...(args.speed ? { speed: args.speed } : {}),
          ...(args.avoid ? { avoid: args.avoid } : {}),
          ...(args.weather ? { weather: args.weather } : {}),
          ...(args.traffic ? { traffic: args.traffic } : {}),
          ...(resultOptions ? { resultOptions } : {}),
          ...(args.extra ?? {}),
        };
        const result = await getClient().plan(request);
        return withViewUrl(args.detail === "full" ? result : slimPlan(result));
      },
    ),
  );

  server.registerTool(
    "abrp_plan_raw",
    {
      title: "Plan an EV route (raw request)",
      description:
        "Escape hatch for full control: POST a complete PlanRequest body to /plan exactly as documented in the Iternio v2 OpenAPI spec. Billed per successful plan. Returns the summarised result (map geometry stripped) by default; pass detail:'full' for the complete response.",
      inputSchema: {
        request: z
          .record(z.string(), z.unknown())
          .describe("A full PlanRequest / PlanRequestWithTelemetry JSON object."),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "'summary' (default) strips bulky map geometry; 'full' returns everything (may exceed client size limits).",
          ),
      },
    },
    handler(
      async ({ request, detail }: { request: Record<string, unknown>; detail?: "summary" | "full" }) => {
        const result = await getClient().plan(request);
        return withViewUrl(detail === "full" ? result : slimPlan(result));
      },
    ),
  );

  server.registerTool(
    "abrp_refresh_route",
    {
      title: "Refresh an in-progress route",
      description:
        "Re-optimise a route mid-trip from the latest position and state of charge (POST /route/refresh). Takes a raw RefreshRequestWithTelemetry body (route calibration + telemetry data points) as documented in the v2 spec. Returns the summarised refreshed plan.",
      inputSchema: {
        request: z
          .record(z.string(), z.unknown())
          .describe("A RefreshRequestWithTelemetry JSON object (route + telemetry/calibration)."),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe("'summary' (default) strips map geometry; 'full' returns everything."),
      },
    },
    handler(
      async ({ request, detail }: { request: Record<string, unknown>; detail?: "summary" | "full" }) => {
        const result = await getClient().refreshRoute(request);
        return withViewUrl(detail === "full" ? result : slimPlan(result));
      },
    ),
  );

  server.registerTool(
    "abrp_plan_trip",
    {
      title: "Plan a multi-day EV road trip",
      description:
        "Plan a long route and split it into daily driving legs under a maximum drive-time-per-day, each ending at a charger town that makes a natural overnight stop. Returns a day-by-day itinerary (human-readable `itinerary` text + structured `days`) and an ABRP `viewUrl`. Use this for road trips that span more than one day. Billed once per plan.",
      inputSchema: {
        destinations: z
          .array(destinationSchema)
          .min(2)
          .describe("Ordered stops; first = origin, last = final destination. At least 2."),
        typecode: z.string().describe("Vehicle model typecode (use abrp_find_vehicle to look it up)."),
        maxDriveHoursPerDay: z
          .number()
          .min(1)
          .max(14)
          .optional()
          .describe("Cap on actual driving hours per day before an overnight stop (default 8)."),
        departDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe(
            "Date of the first day's departure, YYYY-MM-DD. If set, each day gets a date and clock times.",
          ),
        dailyDepartTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .optional()
          .describe(
            "Local time you set off each morning, HH:MM (default 09:00). Times are treated as local/CET.",
          ),
        currentSocFrac: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Starting state of charge 0–1 (default 0.9)."),
        configuration: z
          .string()
          .optional()
          .describe(
            "Consumption modifier for towing/load, e.g. 'TRAILER-SMALL', 'TRAILER-MEDIUM', 'TRAILER-LARGE' for a caravan.",
          ),
        charging: chargingSchema.optional(),
        speed: speedSchema.optional(),
        avoid: avoidSchema.optional(),
        weather: weatherSchema.optional(),
        currency: z
          .string()
          .length(3)
          .optional()
          .describe("3-letter currency for charging costs, e.g. 'DKK'."),
        units: z.enum(["METRIC", "IMPERIAL"]).optional().describe("Units in the response (default METRIC)."),
      },
    },
    handler(
      async (args: {
        destinations: DestinationInput[];
        typecode: string;
        maxDriveHoursPerDay?: number;
        departDate?: string;
        dailyDepartTime?: string;
        currentSocFrac?: number;
        configuration?: string;
        charging?: Record<string, unknown>;
        speed?: Record<string, unknown>;
        avoid?: Record<string, unknown>;
        weather?: Record<string, unknown>;
        currency?: string;
        units?: "METRIC" | "IMPERIAL";
      }) => {
        const resultOptions = toResultOptions(args);
        const request: Record<string, unknown> = {
          destinations: args.destinations.map(toApiDestination),
          vehicle: {
            identifier: { type: "TYPECODE", value: args.typecode },
            ...(args.currentSocFrac !== undefined ? { currentSocFrac: args.currentSocFrac } : {}),
            ...(args.configuration ? { configuration: args.configuration } : {}),
          },
          ...(args.charging ? { charging: toApiCharging(args.charging) } : {}),
          ...(args.speed ? { speed: args.speed } : {}),
          ...(args.avoid ? { avoid: args.avoid } : {}),
          ...(args.weather ? { weather: args.weather } : {}),
          ...(resultOptions ? { resultOptions } : {}),
        };
        const result = await getClient().plan(request);
        return summarizeTrip(result, {
          maxDriveHoursPerDay: args.maxDriveHoursPerDay ?? 8,
          departDate: args.departDate,
          dailyDepartTime: args.dailyDepartTime ?? "09:00",
        });
      },
    ),
  );

  // --- Vehicles & models ---------------------------------------------------
  server.registerTool(
    "abrp_find_vehicle",
    {
      title: "Find a vehicle / typecode",
      description:
        "Search ABRP's vehicle-model catalogue by name to get the exact `typecode` that planning needs — e.g. query 'model y standard range' → tesla:my:19:bt36:none. ALWAYS use this to resolve a vehicle instead of guessing a typecode, since the wrong code changes range and charging. All matching terms must appear in the model name.",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Free-text search across model names, e.g. 'model y standard range', 'id.4 77', 'rivian r1s'.",
          ),
        limit: z.number().int().min(1).max(50).optional().describe("Max matches to return (default 15)."),
      },
    },
    handler(async ({ query, limit }: { query: string; limit?: number }) => {
      const models = await getCarModels(getClient());
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = models
        .filter((m) => {
          const hay = m.name.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
        .slice(0, limit ?? 15)
        .map((m) => ({ name: m.name.replace(/;/g, " · "), typecode: m.typecode }));
      return { query, matchCount: matches.length, totalModels: models.length, matches };
    }),
  );

  server.registerTool(
    "abrp_list_vehicles",
    {
      title: "List my vehicles",
      description:
        "List the vehicles on the authenticated ABRP account and their typecodes. Requires a user session (X-ABRP-SESSION).",
      inputSchema: {
        countryCode3: z
          .string()
          .length(3)
          .optional()
          .describe("Optional ISO 3166-1 alpha-3 country code to localize results, e.g. 'SWE'."),
      },
    },
    handler(async ({ countryCode3 }: { countryCode3?: string }) =>
      getClient().listVehicles({ countryCode3 }),
    ),
  );

  server.registerTool(
    "abrp_get_charge_curve",
    {
      title: "Get charge curve",
      description:
        "Get a vehicle model's charge curve (power vs SoC) at a specific charger and starting SoC.",
      inputSchema: {
        typecode: z.string().describe("Vehicle model typecode, e.g. 'rivian:r1s:21:135'."),
        chargerId: z.number().int().optional().describe("ABRP charger id to evaluate the curve against."),
        startSoc: z.number().optional().describe("Starting state of charge in percent (0–100), e.g. 10."),
        calibrationState: z
          .string()
          .optional()
          .describe("Calibration state from a prior plan/refresh; may affect charge speed."),
      },
    },
    handler(
      async (args: { typecode: string; chargerId?: number; startSoc?: number; calibrationState?: string }) =>
        getClient().chargeCurve(args.typecode, {
          chargerId: args.chargerId,
          startSoc: args.startSoc,
          calibrationState: args.calibrationState,
        }),
    ),
  );

  server.registerTool(
    "abrp_get_reference_consumption",
    {
      title: "Get reference consumption",
      description:
        "Get a vehicle model's reference energy consumption (Wh/km @ ~110 km/h) by typecode. Optional config modifiers.",
      inputSchema: {
        typecode: z.string().describe("Vehicle model typecode, e.g. 'rivian:r1s:21:135'."),
        extraMassKg: z.number().optional().describe("Additional mass in kg (load/trailer)."),
        manualRefCons: z.number().optional().describe("Manual reference consumption override (Wh/km)."),
        vehicleConfigType: z.string().optional().describe("Vehicle configuration type (advanced)."),
        vehicleConfigKey: z.string().optional().describe("Vehicle configuration key (advanced)."),
      },
    },
    handler(
      async (args: {
        typecode: string;
        extraMassKg?: number;
        manualRefCons?: number;
        vehicleConfigType?: string;
        vehicleConfigKey?: string;
      }) =>
        getClient().refConsByTypecode(args.typecode, {
          extraMassKg: args.extraMassKg,
          manualRefCons: args.manualRefCons,
          vehicleConfigType: args.vehicleConfigType,
          vehicleConfigKey: args.vehicleConfigKey,
        }),
    ),
  );

  // --- Range ---------------------------------------------------------------
  server.registerTool(
    "abrp_estimate_range",
    {
      title: "Estimate range",
      description:
        "Create a range plot: the set of points reachable from a location for a given vehicle and conditions (alpha). Provide a full RangeRequest body.",
      inputSchema: {
        request: z
          .record(z.string(), z.unknown())
          .describe("A RangeRequest JSON object (location + vehicle + conditions)."),
      },
    },
    handler(async ({ request }: { request: Record<string, unknown> }) => getClient().range(request)),
  );

  // --- Chargers ------------------------------------------------------------
  server.registerTool(
    "abrp_get_chargers",
    {
      title: "Get chargers by id",
      description: "Fetch one or more chargers by their ABRP ids (order preserved).",
      inputSchema: {
        chargerIds: z.array(z.number().int()).min(1).max(1000).describe("Charger ids to fetch."),
      },
    },
    handler(async ({ chargerIds }: { chargerIds: number[] }) => getClient().getChargers(chargerIds)),
  );

  server.registerTool(
    "abrp_get_charger",
    {
      title: "Get charger by id",
      description: "Fetch a single charger by its ABRP id.",
      inputSchema: { chargerId: z.number().int().describe("The ABRP charger id.") },
    },
    handler(async ({ chargerId }: { chargerId: number }) => getClient().getCharger(chargerId)),
  );

  server.registerTool(
    "abrp_search_chargers",
    {
      title: "Search chargers near a point",
      description: "Find chargers around a coordinate, sorted by power, distance, or a weighted combination.",
      inputSchema: {
        lat: z.number().describe("Latitude of the search center."),
        long: z.number().describe("Longitude of the search center."),
        maxDistance: z
          .number()
          .int()
          .min(1)
          .max(500000)
          .optional()
          .describe("Max distance in meters (default 50000)."),
        sortBy: z
          .enum(["POWER", "DISTANCE", "POWER_AND_DISTANCE"])
          .optional()
          .describe("Sort/selection method (default POWER_AND_DISTANCE)."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Additional GeoSearchParams (filters) merged verbatim."),
      },
    },
    handler(
      async (args: {
        lat: number;
        long: number;
        maxDistance?: number;
        sortBy?: "POWER" | "DISTANCE" | "POWER_AND_DISTANCE";
        extra?: Record<string, unknown>;
      }) =>
        getClient().searchChargersGeopoint({
          location: { lat: args.lat, long: args.long },
          maxDistance: args.maxDistance ?? 50000,
          sortBy: args.sortBy ?? "POWER_AND_DISTANCE",
          ...(args.extra ?? {}),
        }),
    ),
  );

  // --- Networks ------------------------------------------------------------
  server.registerTool(
    "abrp_search_networks",
    {
      title: "Search charging networks",
      description:
        "Search charging networks by name to get their ids — use the ids in a plan's `charging.networks` to prefer or exclude networks (e.g. Ionity-only, avoid X).",
      inputSchema: {
        name: z.string().describe("Network name to match, e.g. 'ionity', 'tesla', 'fastned'."),
        limit: z.number().int().min(1).max(100).optional().describe("Max networks to return (default 10)."),
      },
    },
    handler(async ({ name, limit }: { name: string; limit?: number }) =>
      getClient().searchNetworks(name, limit ?? 10),
    ),
  );

  // --- Telemetry (v1, free) ------------------------------------------------
  server.registerTool(
    "abrp_send_telemetry",
    {
      title: "Send live telemetry",
      description:
        "Push a live vehicle telemetry datapoint to ABRP via the free v1 /tlm/send endpoint. Requires your ABRP user token. Units follow the v1 spec: soc in %, speed in km/h, power in kW, temps in °C.",
      inputSchema: {
        utc: z.number().int().describe("UNIX timestamp in seconds for this datapoint."),
        soc: z.number().min(0).max(100).describe("State of charge in percent (0–100)."),
        lat: z.number().describe("Latitude."),
        lon: z.number().describe("Longitude."),
        car_model: z.string().optional().describe("Vehicle typecode, e.g. 'rivian:r1s:21:135'."),
        speed: z.number().optional().describe("Speed in km/h."),
        is_charging: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe("1 if charging, else 0."),
        is_dcfc: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe("1 if DC fast charging."),
        power: z.number().optional().describe("Battery power in kW (negative = charging)."),
        voltage: z.number().optional().describe("Battery voltage in V."),
        current: z.number().optional().describe("Battery current in A."),
        soh: z.number().optional().describe("State of health in percent."),
        heading: z.number().optional().describe("Heading in degrees."),
        elevation: z.number().optional().describe("Elevation in meters."),
        ext_temp: z.number().optional().describe("External temperature in °C."),
        batt_temp: z.number().optional().describe("Battery temperature in °C."),
        odometer: z.number().optional().describe("Odometer in km."),
        capacity: z.number().optional().describe("Usable battery capacity in kWh."),
        kwh_charged: z.number().optional().describe("Energy added this session in kWh."),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Any additional tlm fields merged verbatim."),
      },
    },
    handler(async (args: Record<string, unknown>) => {
      const { extra, ...tlm } = args as { extra?: Record<string, unknown> } & Record<string, unknown>;
      const payload = Object.fromEntries(
        Object.entries({ ...tlm, ...(extra ?? {}) }).filter(([, v]) => v !== undefined),
      );
      return getClient().sendTelemetry(payload);
    }),
  );
}
