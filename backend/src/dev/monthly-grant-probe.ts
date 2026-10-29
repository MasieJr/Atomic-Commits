import { OpenPaymentsClientError, type GrantWithAccessToken } from "@interledger/open-payments";
import { ProofStepError } from "../services/payment-proof-run";

// Observation only: this diagnostic never creates ApprovedSpending or enables a debit.
const PROBE_DEBIT = { value: "1", assetCode: "ZAR", assetScale: 2 } as const;

export type MonthlyProbeCounter = "NOT_READ" | "NULL_PAIR" | "ZERO_DEBIT" | "UNVERIFIABLE";
type LimitComparison = "MATCH" | "MISSING" | "DIFFERENT" | "NOT_CHECKED";
export type MonthlyProbeResult = {
  status: "OBSERVED" | "INCONCLUSIVE";
  requestedInterval: string;
  requestedDebit: typeof PROBE_DEBIT;
  request: "FINALIZED" | "REJECTED" | "UNCONFIRMED";
  providerStatus?: number;
  providerCode?: string;
  returnedScope: "EXACT" | "MISMATCH" | "NOT_CHECKED";
  returnedInterval: LimitComparison;
  returnedDebit: LimitComparison;
  counter: MonthlyProbeCounter;
  cancellation: "CANCELLED" | "FAILED" | "UNKNOWN";
};

// No quote, incoming-payment, outgoing-payment-create or token-rotation port exists.
export interface MonthlyProbePorts {
  request(interval: string, debit: typeof PROBE_DEBIT): Promise<GrantWithAccessToken>;
  readSpent(accessToken: string): Promise<unknown>;
  cancel(grant: GrantWithAccessToken): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A 4xx describes a rejection of the request, not a conclusion about interval
// support or cleanup. Free-form provider text is never stored in the result.
function recordRequestFailure(result: MonthlyProbeResult, error: unknown): void {
  const cause = error instanceof ProofStepError ? error.original : error;
  if (!(cause instanceof OpenPaymentsClientError)) return;
  const status = cause.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    result.providerStatus = status;
    if (status >= 400 && status < 500 && status !== 408 && !cause.validationErrors?.length) result.request = "REJECTED";
  }
  const codes = ["invalid_client", "invalid_request", "request_denied", "too_fast", "invalid_continuation", "invalid_rotation"];
  if (typeof cause.code === "string" && codes.includes(cause.code)) result.providerCode = cause.code;
}

// Compare only; never turn the observed token into spendable authority. Exact scope
// is required before even the read-only counter request, and unknown fields fail closed.
function inspectScope(grant: unknown, payerId: string, interval: string): {
  token?: string; interval: LimitComparison; debit: LimitComparison;
} {
  const result: { token?: string; interval: LimitComparison; debit: LimitComparison } = { interval: "NOT_CHECKED", debit: "NOT_CHECKED" };
  if (!isRecord(grant) || !isRecord(grant.access_token)) return result;
  const token = grant.access_token;
  if (!Array.isArray(token.access) || token.access.length !== 1 || !isRecord(token.access[0])) return result;
  const access = token.access[0];
  if (!isRecord(access.limits)) return result;
  const limits = access.limits;
  result.interval = limits.interval === undefined ? "MISSING" : limits.interval === interval ? "MATCH" : "DIFFERENT";
  const debit = limits.debitAmount;
  result.debit = debit === undefined ? "MISSING" : isRecord(debit) &&
    !Object.keys(debit).some((key) => !["value", "assetCode", "assetScale"].includes(key)) &&
    debit.value === PROBE_DEBIT.value && debit.assetCode === PROBE_DEBIT.assetCode && debit.assetScale === PROBE_DEBIT.assetScale
    ? "MATCH" : "DIFFERENT";
  if (typeof token.value !== "string" || token.value === "" ||
      typeof token.expires_in !== "number" || token.expires_in <= 0 || !Number.isSafeInteger(token.expires_in * 1000)) return result;
  if (Object.keys(access).some((key) => !["type", "identifier", "actions", "limits"].includes(key)) ||
      access.type !== "outgoing-payment" || access.identifier !== payerId ||
      !Array.isArray(access.actions) || access.actions.length !== 2 ||
      !access.actions.includes("create") || !access.actions.includes("read")) return result;
  if (Object.keys(limits).some((key) => key !== "debitAmount" && key !== "interval") ||
      result.interval !== "MATCH" || result.debit !== "MATCH") return result;
  result.token = token.value;
  return result;
}

function inspectCounter(amounts: unknown): MonthlyProbeCounter {
  if (!isRecord(amounts) || !Object.hasOwn(amounts, "spentDebitAmount") || !Object.hasOwn(amounts, "spentReceiveAmount")) return "UNVERIFIABLE";
  if (amounts.spentDebitAmount === null && amounts.spentReceiveAmount === null) return "NULL_PAIR";
  const debit = amounts.spentDebitAmount;
  const receive = amounts.spentReceiveAmount;
  if (isRecord(debit) && debit.value === "0" && debit.assetCode === PROBE_DEBIT.assetCode && debit.assetScale === PROBE_DEBIT.assetScale &&
      isRecord(receive) && receive.value === "0" && typeof receive.assetCode === "string" && receive.assetCode !== "" &&
      typeof receive.assetScale === "number" && Number.isInteger(receive.assetScale) && receive.assetScale >= 0 && receive.assetScale <= 255) {
    return "ZERO_DEBIT";
  }
  return "UNVERIFIABLE";
}

export function monthlyProbeInterval(start: Date): string {
  if (!(start instanceof Date) || !Number.isFinite(start.getTime())) throw new Error("The probe needs a valid UTC start time.");
  return `R1/${start.toISOString().replace(/\.\d{3}Z$/, "Z")}/P1M`;
}

// A finalized grant is always passed to cancellation, including on mismatched
// scope or a failed read. A request without a finalized response stays unknown.
export async function observeMonthlyGrant(
  ports: MonthlyProbePorts,
  payerId: string,
  start: Date,
): Promise<MonthlyProbeResult> {
  if (typeof payerId !== "string" || payerId === "") throw new Error("The probe needs a payer identifier.");
  const interval = monthlyProbeInterval(start);
  const result: MonthlyProbeResult = {
    status: "INCONCLUSIVE", requestedInterval: interval, requestedDebit: { ...PROBE_DEBIT },
    request: "UNCONFIRMED", returnedScope: "NOT_CHECKED", returnedInterval: "NOT_CHECKED", returnedDebit: "NOT_CHECKED",
    counter: "NOT_READ", cancellation: "UNKNOWN",
  };
  let grant: GrantWithAccessToken;
  try {
    grant = await ports.request(interval, { ...PROBE_DEBIT });
  } catch (error) {
    recordRequestFailure(result, error);
    return result;
  }
  result.request = "FINALIZED";
  try {
    const scope = inspectScope(grant, payerId, interval);
    result.returnedInterval = scope.interval;
    result.returnedDebit = scope.debit;
    result.returnedScope = scope.token === undefined ? "MISMATCH" : "EXACT";
    if (scope.token !== undefined) {
      try {
        result.counter = inspectCounter(await ports.readSpent(scope.token));
      } catch {
        result.counter = "UNVERIFIABLE";
      }
    }
  } finally {
    try {
      await ports.cancel(grant);
      result.cancellation = "CANCELLED";
    } catch {
      result.cancellation = "FAILED";
    }
  }
  if (result.returnedScope === "EXACT" && (result.counter === "NULL_PAIR" || result.counter === "ZERO_DEBIT") && result.cancellation === "CANCELLED") {
    result.status = "OBSERVED";
  }
  return result;
}
