import connectPgSimple from "connect-pg-simple";
import express from "express";
import session from "express-session";

import { createAuthController } from "./controllers/auth";
import { AuthStorageError } from "./errors/auth";
import { createAuthRateLimiter } from "./middleware/auth-rate-limit";
import { errorHandler } from "./middleware/error-handler";
import { createUserRepository } from "./models/users";
import { createAuthRouter } from "./routes/auth";
import { sessionCookieName, sessionCookieOptions } from "./services/session";
import { createDatabasePool } from "./db/pool";

interface AppOptions {
  databaseUrl?: string;
  sessionSecret?: string;
  production?: boolean;
}

const PgSessionStore = connectPgSimple(session);
/* register the express app */
export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
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
    options.sessionSecret &&
    options.sessionSecret.trim().length >= 32,
  );

  /* make pool if configged, then a sessions store */
  const pool = configured
    ? createDatabasePool(options.databaseUrl!)
    : undefined;
  const store = pool
    ? new PgSessionStore({
        pool,
        schemaName: "app_private",
        tableName: "session",
        createTableIfMissing: false,
        errorLog: () =>
          console.error("PostgreSQL session storage is unavailable."),
      })
    : undefined;

  if (pool && store) {
    const cookieOptions = sessionCookieOptions(options.production ?? false);
    const users = createUserRepository(pool);
    const controller = createAuthController(users, cookieOptions);
    const sessionMiddleware = session({
      name: sessionCookieName,
      store,
      secret: options.sessionSecret!,
      resave: false,
      saveUninitialized: false,
      cookie: { ...cookieOptions, maxAge: 2 * 60 * 60 * 1000 },
    });

    app.use(
      "/api/auth",
      (req, res, next) => {
        sessionMiddleware(req, res, (error: unknown) => {
          next(
            error
              ? new AuthStorageError("Session storage is unavailable.")
              : undefined,
          );
        });
      },
      createAuthRouter(controller),
    );
  } else {
    app.use("/api/auth", (_req, res) => {
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
      await store?.close();
      await pool?.end();
    },
  };
}
