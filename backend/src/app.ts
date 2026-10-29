import express from "express";
import helmet from "helmet";

import { createAuthController } from "./controllers/auth";
import { createTotpDevicesController } from "./controllers/totp-devices";
import { createAuthRateLimiter } from "./middleware/auth-rate-limit";
import { errorHandler } from "./middleware/error-handler";
import { createUserRepository } from "./models/users";
import { createAuthRouter } from "./routes/auth";
import { createTotpDevicesRouter } from "./routes/totp-devices";
import { createDataEncryptionFromEnv, type DataEncryption } from "./services/data-encryption";
import { createTotpEnrollmentService } from "./services/totp-enrollment";
import { createAccessTokenService } from "./services/tokens";
import { createDatabasePool } from "./db/pool";

interface AppOptions {
  databaseUrl?: string;
  jwtSecret?: string;
  /* base64 of 32 random bytes; separate from jwtSecret */
  dataEncryptionKey?: string;
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
    if (encryption) {
      const devices = createTotpEnrollmentService({ pool, encryption });
      app.use("/api/devices", createTotpDevicesRouter(createTotpDevicesController(devices), tokens));
    } else {
      app.use("/api/devices", (_req, res) => {
        res.status(503).json({ error: "Device enrollment is not configured yet." });
      });
    }
  } else {
    app.use("/api/auth", (_req, res) => {
      res.status(503).json({ error: "Authentication is not configured yet." });
    });
    app.use("/api/devices", (_req, res) => {
      res.status(503).json({ error: "Authentication is not configured yet." });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(errorHandler);

  return {
    app,
    authConfigured: configured,
    async close(): Promise<void> {
      await pool?.end();
    },
  };
}
