import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";

import { OpenPaymentsClientError, type Quote } from "@interledger/open-payments";

export type ProofMode = "a" | "b" | "both" | "c";
export type Amount = Quote["debitAmount"];
export type PaymentState = "PREPARED" | "SUBMITTING" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN" | "REJECTED";

export interface PaymentEvidence {
  label: string;
  state: PaymentState;
  incomingPaymentId: string;
  quoteId: string;
  quotedDebit: Amount;
  quotedReceive: Amount;
  outgoingPaymentId?: string;
  sentAmount?: Amount;
  receivedAmount?: Amount;
  expectedRejection?: boolean;
}

export interface ProofConfig {
  receiveMinor: string;
  budgetMinor: string;
  callbackPort: number;
  consentTimeoutMs: number;
  settlementTimeoutMs: number;
}

// ports/timers use numbers; money stays as integer strings
function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

// use BigInt for minor units so decimal maths doesn't change the amount
export function minorValue(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,17})$/.test(value)) throw new Error("Amounts must be integer minor-unit strings.");
  return BigInt(value);
}

export function sameAsset(left: Amount, right: Amount): boolean {
  return left.assetCode === right.assetCode && left.assetScale === right.assetScale;
}

// place the decimal using the asset scale, without converting to a float
export function formatAmount(amount: Amount): string {
  const digits = minorValue(amount.value).toString().padStart(amount.assetScale + 1, "0");
  const value = amount.assetScale
    ? `${digits.slice(0, -amount.assetScale)}.${digits.slice(-amount.assetScale)}`
    : digits;
  return `${value} ${amount.assetCode}`;
}

// small dev defaults; the wallet metadata tells us which currencies they mean
export function readProofConfig(): ProofConfig {
  if (process.env.NODE_ENV === "production") throw new Error("Payment proof commands are development-only.");
  const receiveMinor = process.env.PAYMENT_PROOF_RECEIVE_AMOUNT_MINOR?.trim() || "10";
  const budgetMinor = process.env.PAYMENT_PROOF_BUDGET_MINOR?.trim() || "500";
  if (minorValue(receiveMinor) === 0n || minorValue(budgetMinor) === 0n) {
    throw new Error("Proof receive amounts and spending budgets must be positive.");
  }
  return {
    receiveMinor,
    budgetMinor,
    callbackPort: integerSetting("PAYMENT_PROOF_CALLBACK_PORT", 3999, 1024, 65535),
    consentTimeoutMs: integerSetting("PAYMENT_PROOF_CONSENT_TIMEOUT_SECONDS", 600, 30, 900) * 1000,
    settlementTimeoutMs: integerSetting("PAYMENT_PROOF_SETTLEMENT_TIMEOUT_SECONDS", 90, 10, 300) * 1000,
  };
}

export class ProofStepError extends Error {
  constructor(readonly step: string, readonly original: unknown) {
    super(`Payment proof stopped at: ${step}`);
  }
}

// keep local run evidence without writing grant tokens
export class ProofRun {
  readonly controller = new AbortController();
  readonly report: {
    version: number;
    runId: string;
    mode: ProofMode;
    startedAt: string;
    status: string;
    currentStep: string;
    payments: PaymentEvidence[];
    results: Record<string, unknown>;
    error?: Record<string, unknown>;
  };
  private readonly secrets = new Set<string>();
  private readonly directory = resolve(".env.payment-proofs");
  private lock?: FileHandle;

  constructor(mode: ProofMode) {
    this.report = {
      version: 1,
      runId: randomUUID(),
      mode,
      startedAt: new Date().toISOString(),
      status: "RUNNING",
      currentStep: "initialization",
      payments: [],
      results: {},
    };
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // only one proof process can own this lock
    this.lock = await open(resolve(this.directory, "active.lock"), "wx").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error("A proof is active or was interrupted. Inspect .env.payment-proofs before removing its active.lock.");
      }
      throw error;
    });
    try {
      await this.lock.writeFile(String(process.pid));
      let previous: { payments?: PaymentEvidence[] } | undefined;
      try {
        previous = JSON.parse(await readFile(resolve(this.directory, "latest.json"), "utf8"));
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      // an unclear old payment must be checked before we start another run
      if (previous?.payments?.some((payment) => ["SUBMITTING", "PROCESSING", "UNKNOWN"].includes(payment.state))) {
        throw new Error("A previous payment outcome is unresolved. Reconcile it in provider history before starting another proof.");
      }
      await this.save();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  rememberSecret(value: string): void {
    if (value) this.secrets.add(value);
  }

  private redact(value: string): string {
    let output = value;
    for (const secret of this.secrets) output = output.split(secret).join("[redacted]");
    return output;
  }

  private json(value: unknown): string {
    // redact string values before JSON escaping can hide a token from the check
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? this.redact(item) : item, 2) + "\n";
  }

  safeError(error: unknown): Record<string, unknown> {
    // retain the failed step and useful provider fields, without dumping the SDK error
    const step = error instanceof ProofStepError ? error.step : this.report.currentStep;
    const original = error instanceof ProofStepError ? error.original : error;
    return {
      step,
      message: this.redact(original instanceof Error ? original.message : "Unexpected proof error.").slice(0, 1200),
      ...(original instanceof OpenPaymentsClientError ? {
        status: original.status,
        code: original.code,
        description: original.description ? this.redact(original.description).slice(0, 1200) : undefined,
      } : {}),
    };
  }

  async step<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.controller.signal.throwIfAborted();
    this.report.currentStep = name;
    this.report.status = "RUNNING";
    await this.save();
    console.log(JSON.stringify({ event: "step", step: name }));
    try {
      // Ctrl+C may have arrived while the report was being saved
      this.controller.signal.throwIfAborted();
      return await operation();
    } catch (error) {
      throw error instanceof ProofStepError ? error : new ProofStepError(name, error);
    }
  }

  async save(): Promise<void> {
    // replace complete files so a reader doesn't get half-written JSON
    const json = this.json(this.report);
    for (const filename of [`${this.report.runId}.json`, "latest.json"]) {
      const path = resolve(this.directory, filename);
      await writeFile(path + ".tmp", json, { mode: 0o600 });
      await rename(path + ".tmp", path);
    }
  }

  async writeReceipt(proof: "a" | "b", result: Record<string, unknown>): Promise<void> {
    // successful receipts are separate from latest.json, which every run replaces
    const path = resolve(this.directory, `proof-${proof}.json`);
    await writeFile(path + ".tmp", this.json(result), { mode: 0o600 });
    await rename(path + ".tmp", path);
  }

  async readReceipt(proof: "a" | "b"): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(resolve(this.directory, `proof-${proof}.json`), "utf8"));
  }

  async finish(error?: unknown): Promise<void> {
    // an unresolved debit stays UNKNOWN even if the command stopped with an error
    this.report.status = this.report.payments.some((payment) => ["SUBMITTING", "PROCESSING", "UNKNOWN"].includes(payment.state))
      ? "UNKNOWN"
      : error ? "FAILED" : "PASSED";
    if (error) this.report.error = this.safeError(error);
    await this.save();
    console.log(JSON.stringify({
      event: "proof-result",
      status: this.report.status,
      report: resolve(this.directory, `${this.report.runId}.json`),
      ...(error ? { error: this.report.error } : {}),
    }));
  }

  async close(): Promise<void> {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = undefined;
    await unlink(resolve(this.directory, "active.lock"));
  }
}
