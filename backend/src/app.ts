import express from "express";
import helmet from "helmet";

import { createAuthController } from "./controllers/auth";
import { createPaymentGrantsController } from "./controllers/payment-grants";
import { createPaymentsController } from "./controllers/payments";
import { createTotpDevicesController } from "./controllers/totp-devices";
import { createAuthRateLimiter } from "./middleware/auth-rate-limit";
import { errorHandler } from "./middleware/error-handler";
import { createUserRepository } from "./models/users";
import { createAuthRouter } from "./routes/auth";
import { createPaymentsRouter } from "./routes/payments";
import { createTotpDevicesRouter } from "./routes/totp-devices";
import { createDataEncryptionFromEnv, parseEncryptionKey, type DataEncryption } from "./services/data-encryption";
import { createGrantAuthorityStore } from "./services/grant-authority-store";
import { createOfflineRedemptionService, type OfflineRedemptionService } from "./services/offline-redemption";
import { createPaymentGrantService } from "./services/payment-grants";
import { createOpenPaymentsRedemptionProvider } from "./services/open-payments-redemption-provider";
import type { RedemptionProvider } from "./services/redemption-provider";
import { createTotpEnrollmentService } from "./services/totp-enrollment";
import { createAccessTokenService } from "./services/tokens";
import { createDatabasePool } from "./db/pool";

interface AppOptions {
  databaseUrl?: string;
  jwtSecret?: string;
  /* base64 of 32 random bytes; separate from jwtSecret */
  dataEncryptionKey?: string;
  /* tests inject a fake; defaults to the live Test Wallet adapter */
  redemptionProvider?: RedemptionProvider;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
}

/* register the express app */
export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use("/api/auth", createAuthRateLimiter());

  const configured = Boolean(
    options.databaseUrl?.trim() &&
    options.jwtSecret &&
    options.jwtSecret.trim().length >= 32,
  );

  /* make pool if configged, then wire the jwt auth routes */
  /* set when payments are configured; used for crash recovery at startup */
  let redemptions: OfflineRedemptionService | undefined;
  const pool = configured
    ? createDatabasePool(options.databaseUrl!)
    : undefined;

  if (pool) {
    const users = createUserRepository(pool);
    const tokens = createAccessTokenService(options.jwtSecret!);
    const controller = createAuthController(users, tokens);
    app.use("/api/auth", createAuthRouter(controller, tokens));

    /* device enrollment needs the encryption key on top of auth */
    let encryption: DataEncryption | undefined;
    try {
      encryption = createDataEncryptionFromEnv({ DATA_ENCRYPTION_KEY: options.dataEncryptionKey });
    } catch {
      encryption = undefined;
    }
    app.use("/api/devices", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    for (const path of ["/api/offline-redemptions", "/api/payments", "/api/payment-grants"]) {
      app.use(path, (_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
      });
    }
    if (encryption) {
      const devices = createTotpEnrollmentService({ pool, encryption });
      app.use("/api/devices", createTotpDevicesRouter(createTotpDevicesController(devices), tokens));

      const authorities = createGrantAuthorityStore(encryption);
      const provider = options.redemptionProvider ?? createOpenPaymentsRedemptionProvider();
      redemptions = createOfflineRedemptionService({
        pool,
        encryption,
        authorities,
        provider,
        dataKey: parseEncryptionKey(options.dataEncryptionKey),
        confirmTimeoutMs: options.confirmTimeoutMs,
        confirmPollMs: options.confirmPollMs,
      });
      const grants = createPaymentGrantService({ pool, authorities, provider });
      app.use(
        "/api",
        createPaymentsRouter(createPaymentsController(redemptions), createPaymentGrantsController(grants), tokens),
      );
    } else {
      for (const path of ["/api/devices", "/api/offline-redemptions", "/api/payments", "/api/payment-grants"]) {
        app.use(path, (_req, res) => {
          res.status(503).json({ error: "Device enrollment and payments are not configured yet." });
        });
      }
    }
  } else {
    app.use("/api/auth", (_req, res) => {
      res.status(503).json({ error: "Authentication is not configured yet." });
    });
    for (const path of ["/api/devices", "/api/offline-redemptions", "/api/payments", "/api/payment-grants"]) {
      app.use(path, (_req, res) => {
        res.status(503).json({ error: "Authentication is not configured yet." });
      });
    }
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return {
    app,
    authConfigured: configured,
    /* one crash-recovery pass; resolves to undefined when payments are off */
    reconcilePayments: () => redemptions?.reconcilePending(),
    async close(): Promise<void> {
      await pool?.end();
    },
  };
}
