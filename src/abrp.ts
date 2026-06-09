/**
 * Thin typed client for the Iternio / A Better Route Planner (ABRP) API.
 *
 * Spec: https://api.iternio.com/swagger-ui/  (Iternio Planning API v2)
 * Telemetry (v1): https://documenter.getpostman.com/view/7396339/SWTK5a8w
 *
 * Two generations are in play:
 *   - v2 (https://api.iternio.com/2): modern REST, JSON bodies, header auth.
 *     Used for routing, vehicles, chargers, range.
 *   - v1 (https://api.iternio.com/1): legacy; the free `/tlm/send` live-data
 *     endpoint everyone uses for telemetry.
 *
 * Auth headers (v2):
 *   - X-API-KEY      the Planning API key (required on most endpoints)
 *   - X-ABRP-SESSION a user session (user-scoped calls, e.g. vehicle list)
 *   - X-TLM-TOKEN    a telemetry token (v2 telemetry; not used by v1/tlm/send)
 *
 * v1 telemetry auth is via the `api_key` and `token` query/form params instead.
 */

export const DEFAULT_V2_BASE_URL = "https://api.iternio.com/2";
export const DEFAULT_V1_BASE_URL = "https://api.iternio.com/1";

export class AbrpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AbrpError";
  }
}

export interface AbrpClientOptions {
  /** Planning API key — sent as X-API-KEY. Required for v2 endpoints. */
  apiKey?: string;
  /** ABRP user session — sent as X-ABRP-SESSION. Needed for user-scoped calls. */
  session?: string;
  /** Telemetry token — sent as X-TLM-TOKEN (v2 telemetry). */
  tlmToken?: string;
  /** ABRP user token for the v1 /tlm/send endpoint (the `token` param). */
  userToken?: string;
  v2BaseUrl?: string;
  v1BaseUrl?: string;
}

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue>;

export class AbrpClient {
  readonly apiKey?: string;
  readonly session?: string;
  readonly tlmToken?: string;
  readonly userToken?: string;
  private readonly v2BaseUrl: string;
  private readonly v1BaseUrl: string;

  constructor(opts: AbrpClientOptions) {
    this.apiKey = opts.apiKey;
    this.session = opts.session;
    this.tlmToken = opts.tlmToken;
    this.userToken = opts.userToken;
    this.v2BaseUrl = (opts.v2BaseUrl ?? DEFAULT_V2_BASE_URL).replace(/\/?$/, "");
    this.v1BaseUrl = (opts.v1BaseUrl ?? DEFAULT_V1_BASE_URL).replace(/\/?$/, "");
  }

  private requireApiKey(): string {
    if (!this.apiKey) {
      throw new AbrpError("An ABRP Planning API key (X-API-KEY) is required for this call.", 401, {
        message: "missing_api_key",
      });
    }
    return this.apiKey;
  }

  private requireSession(): string {
    if (!this.session) {
      throw new AbrpError(
        "This call needs an ABRP user session (X-ABRP-SESSION). Provide it at login or via the X-ABRP-Session header.",
        401,
        { message: "missing_session" },
      );
    }
    return this.session;
  }

  /** Core v2 request: JSON in, JSON out, header auth. */
  private async v2<T = unknown>(
    method: "GET" | "POST",
    path: string,
    opts: { query?: Query; json?: unknown; session?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "X-API-KEY": this.requireApiKey(),
      Accept: "application/json",
    };
    if (opts.session) headers["X-ABRP-SESSION"] = this.requireSession();
    else if (this.session) headers["X-ABRP-SESSION"] = this.session;
    if (this.tlmToken) headers["X-TLM-TOKEN"] = this.tlmToken;

    let body: string | undefined;
    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    const url = buildUrl(this.v2BaseUrl, path, opts.query);
    const res = await fetch(url, { method, headers, body });
    return parseResponse<T>(res, `${method} ${path}`);
  }

  // --- v2: planning --------------------------------------------------------

  /** Create an EV route plan (billed per successful plan). Body = PlanRequest. */
  plan(request: unknown) {
    return this.v2("POST", "/plan", { json: request });
  }

  /** Re-optimise an in-progress route given fresh telemetry. */
  refreshRoute(request: unknown) {
    return this.v2("POST", "/route/refresh", { json: request });
  }

  /** Range plot: reachable points from a location (alpha). Body = RangeRequest. */
  range(request: unknown) {
    return this.v2("POST", "/range", { json: request });
  }

  // --- v2: vehicles --------------------------------------------------------

  /** List the vehicles on the authenticated user's account (needs a session). */
  listVehicles(query?: { countryCode3?: string }) {
    return this.v2("GET", "/vehicle/_list", {
      query: { countryCode3: query?.countryCode3 },
      session: true,
    });
  }

  /** Charge curve for a vehicle model at a given charger / start SoC (alpha). */
  chargeCurve(typecode: string, body: { chargerId?: number; startSoc?: number; calibrationState?: string }) {
    return this.v2("POST", `/vehicle-model/by-typecode/${encodeURIComponent(typecode)}/charge-curve/get`, {
      json: body,
    });
  }

  /** Reference consumption (Wh/km) for a vehicle model by typecode (alpha). */
  refConsByTypecode(typecode: string, query?: Query) {
    return this.v2("GET", `/vehicle-model/by-typecode/${encodeURIComponent(typecode)}/ref-cons`, { query });
  }

  // --- v2: chargers --------------------------------------------------------

  /** Fetch chargers by id (order preserved). */
  getChargers(chargerIds: number[]) {
    return this.v2("POST", "/charger/_get", { json: { chargerIds } });
  }

  /** Fetch a single charger by id. */
  getCharger(chargerId: number) {
    return this.v2("GET", `/charger/${encodeURIComponent(String(chargerId))}`);
  }

  /** Search chargers around a point. */
  searchChargersGeopoint(body: {
    location: { lat: number; long: number };
    maxDistance: number;
    sortBy: "POWER" | "DISTANCE" | "POWER_AND_DISTANCE";
    [k: string]: unknown;
  }) {
    return this.v2("POST", "/charger/_search/geopoint", { json: body });
  }

  // --- v1: telemetry -------------------------------------------------------

  /**
   * Send a live telemetry datapoint to ABRP (v1 /tlm/send). Free; needs the
   * user token (the `token` param), not a session. The datapoint is sent as a
   * JSON string in the `tlm` form field.
   */
  async sendTelemetry(tlm: Record<string, unknown>): Promise<unknown> {
    const apiKey = this.requireApiKey();
    if (!this.userToken) {
      throw new AbrpError(
        "Telemetry needs your ABRP user token (the v1 `token`). Set it at login or via the X-ABRP-Token header.",
        401,
        { message: "missing_user_token" },
      );
    }
    const form = new URLSearchParams({
      api_key: apiKey,
      token: this.userToken,
      tlm: JSON.stringify(tlm),
    });
    const res = await fetch(`${this.v1BaseUrl}/tlm/send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    return parseResponse(res, "POST /1/tlm/send");
  }

  /**
   * Lightweight credential check: hits the free ref-cons endpoint for a known
   * public typecode. A 200/valid body means the API key works.
   */
  async checkAccess(typecode = "rivian:r1s:21:135") {
    return this.refConsByTypecode(typecode);
  }
}

function buildUrl(base: string, path: string, query?: Query): string {
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function parseResponse<T>(res: Awaited<ReturnType<typeof fetch>>, label: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // keep raw text
    }
    throw new AbrpError(`ABRP API ${label} failed with HTTP ${res.status}`, res.status, parsed);
  }
  if (!text) return text as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}
