import {
  parseApiEnrollmentPacket,
  prepareApiDeviceSlot,
  saveApiDeviceProfile,
  type ApiDeviceProfile,
} from "./local-device-store";

export class ApiEnrollmentError extends Error {}

export interface EligibleGrant {
  readonly authorizationId: string;
  readonly payerWalletAddress: string;
  readonly validUntil: string;
}

export interface ApiEnrollmentOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly deviceHome: string;
  readonly chooseGrant: (grants: readonly EligibleGrant[]) => Promise<number>;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Credentials go only to HTTPS, except for a local development server. */
function apiOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ApiEnrollmentError("Enter a valid API URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ApiEnrollmentError("Use an HTTPS API origin, or HTTP on localhost for development.");
  }
  return url.origin;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function availableGrants(value: unknown, now: number): EligibleGrant[] {
  const rows = asRecord(value)?.grants;
  if (!Array.isArray(rows)) throw new ApiEnrollmentError("The API returned an invalid grant list.");
  const eligible: EligibleGrant[] = [];
  for (const item of rows) {
    const row = asRecord(item);
    const remaining = asRecord(row?.remaining)?.value;
    if (!row || row.status !== "ACTIVE" || row.authoritySource !== "PROVIDER" ||
        typeof row.authorizationId !== "string" || !UUID.test(row.authorizationId) ||
        typeof row.payerWalletAddress !== "string" || typeof row.validUntil !== "string" ||
        !Number.isFinite(Date.parse(row.validUntil)) || Date.parse(row.validUntil) <= now ||
        typeof remaining !== "string" || !/^[0-9]{1,18}$/.test(remaining) || BigInt(remaining) <= 0n) continue;
    eligible.push({ authorizationId: row.authorizationId, payerWalletAddress: row.payerWalletAddress, validUntil: row.validUntil });
  }
  return eligible;
}

/**
 * Log in, select an existing real grant and enroll via the API. Credentials and
 * the one-time packet stay in memory; only the protected device profile is saved.
 */
export async function enrollWithApi(options: ApiEnrollmentOptions): Promise<ApiDeviceProfile> {
  const origin = apiOrigin(options.baseUrl);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;

  async function request(path: string, method: "GET" | "POST", body?: unknown, token?: string): Promise<string> {
    let response: Response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ApiEnrollmentError("Could not reach the API. Check the URL and connection.");
    }
    if (!response.ok) throw new ApiEnrollmentError(`The API rejected the request (HTTP ${response.status}).`);
    let text: string;
    try { text = await response.text(); } catch { throw new ApiEnrollmentError("Could not read the API response."); }
    if (text.length > 64_000) throw new ApiEnrollmentError("The API response was too large.");
    return text;
  }

  function parseJson(text: string): unknown {
    try { return JSON.parse(text); } catch { throw new ApiEnrollmentError("The API returned invalid JSON."); }
  }

  const login = asRecord(parseJson(await request("/api/auth/login", "POST", {
    email: options.email.trim(), password: options.password,
  })));
  const token = login?.token;
  if (typeof token !== "string" || token.length === 0 || token.length > 8192 || /[\r\n]/.test(token)) {
    throw new ApiEnrollmentError("The API did not return a valid login token.");
  }
  const grants = availableGrants(parseJson(await request("/api/payment-grants", "GET", undefined, token)), now());
  if (grants.length === 0) {
    throw new ApiEnrollmentError("No active provider grant is available. The API must provide an approved grant before enrollment.");
  }
  const index = grants.length === 1 ? 0 : await options.chooseGrant(grants);
  if (!Number.isInteger(index) || index < 0 || index >= grants.length) {
    throw new ApiEnrollmentError("No grant was selected.");
  }

  // The server returns the secret only once, so check the protected destination first.
  prepareApiDeviceSlot(options.deviceHome);
  let packet: ApiDeviceProfile;
  try {
    const text = await request("/api/devices/totp/enroll", "POST", {
      authorizationId: grants[index].authorizationId,
      deviceName: "Atomic CLI",
    }, token);
    packet = parseApiEnrollmentPacket(text, now());
  } catch (error) {
    const detail = error instanceof ApiEnrollmentError ? error.message : "The enrollment response was invalid.";
    throw new ApiEnrollmentError(`${detail} Enrollment may already exist on the server; check before trying again.`);
  }
  try {
    saveApiDeviceProfile(options.deviceHome, packet);
  } catch {
    throw new ApiEnrollmentError(`The device secret could not be saved. Revoke server device ${packet.prefix} before enrolling again.`);
  }
  return packet;
}
