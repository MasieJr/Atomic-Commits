import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";

import { buildOpenApiSpec } from "./docs/openapi";

import { createAuthController } from "./controllers/auth";
import { createPaymentGrantsController } from "./controllers/payment-grants";
import { createPaymentsController } from "./controllers/payments";
import { createTotpDevicesController } from "./controllers/totp-devices";
import { createAuthRateLimiter } from "./middleware/auth-rate-limit";
import { errorHandler } from "./middleware/error-handler";
import { createUserRepository } from "./models/users";
import { createAuthRouter } from "./routes/auth";
import { createGoogleOAuthRouter } from "./routes/google-oauth";
import { createPaymentsRouter } from "./routes/payments";
import { createTotpDevicesRouter } from "./routes/totp-devices";
import { createWalletsRouter } from "./routes/wallets";
import { createDataEncryption, parseDataEncryptionKeyring, type DataEncryption } from "./services/data-encryption";
import { createSupabaseEmailVerification, type EmailVerification } from "./services/email-verification";
import { createGrantAuthorityStore } from "./services/grant-authority-store";
import { createGoogleOAuthService, googleOAuthPath, type GoogleOAuthService } from "./services/google-oauth";
import { createOfflineRedemptionService, type OfflineRedemptionService } from "./services/offline-redemption";
import { createPaymentGrantApprovalService } from "./services/payment-grant-approval";
import { createPaymentGrantService, type PaymentGrantService } from "./services/payment-grants";
import { logEvent, type LogEvent } from "./services/log";
import { createOpenPaymentsRedemptionProvider } from "./services/open-payments-redemption-provider";
import type { RedemptionProvider } from "./services/redemption-provider";
import { createRefreshTokenService } from "./services/refresh-tokens";
import { createTotpEnrollmentService } from "./services/totp-enrollment";
import { createAccessTokenService } from "./services/tokens";
import { createVerifiedWalletService } from "./services/verified-wallets";
import { createWalletVerificationProvider, type WalletVerificationProvider } from "./services/wallet-verification-provider";
import { createDatabasePool } from "./db/pool";

interface AppOptions {
  databaseUrl?: string;
  jwtSecret?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleAuthEnabled?: boolean;
  /* base64 of 32 random bytes; separate from jwtSecret */
  dataEncryptionKey?: string;
  dataEncryptionKeyVersion?: string;
  dataEncryptionKeyV1?: string;
  /* tests inject a fake; defaults to the live Test Wallet adapter */
  redemptionProvider?: RedemptionProvider;
  /* tests inject a fake; defaults to Supabase email verification when configured */
  emailVerification?: EmailVerification;
  walletVerificationProvider?: WalletVerificationProvider;
  webAllowedOrigins?: readonly string[];
  trustProxyLoopback?: boolean;
  confirmTimeoutMs?: number;
  confirmPollMs?: number;
  /* public https base URL of this API, used as the wallet's redirect target */
  publicBaseUrl?: string;
  log?: LogEvent;
  /* TOTP tolerance: 0 = strict 30 s window, 1 = also adjacent windows (default) */
  allowedDriftSteps?: 0 | 1;
  /* Allows tests to freeze redemption verification time. */
  redemptionNow?: () => number;
}

/* register the express app */
export function createApp(options: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxyLoopback) app.set("trust proxy", "loopback");
  const allowedOrigins = new Set(options.webAllowedOrigins ?? []);
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (!origin) return next();
    res.vary("Origin");
    const allowed = allowedOrigins.has(origin);
    if (allowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(allowed ? 204 : 403);
      return;
    }
    next();
  });
  /*
   * API docs (Swagger UI). Mounted before the global helmet() on purpose: its
   * default CSP has upgrade-insecure-requests, which would make browsers load
   * the UI's own files over https and break the page while the server runs on
   * plain http. Same headers otherwise; scripts still only from 'self'.
   */
  const openApiSpec = buildOpenApiSpec(options.publicBaseUrl?.trim().replace(/\/+$/, "") || undefined);
  const docsHelmet = helmet({
    contentSecurityPolicy: { useDefaults: true, directives: { upgradeInsecureRequests: null } },
    /* ignored by browsers on plain http anyway; avoids a console warning on the docs page */
    crossOriginOpenerPolicy: false,
  });
  app.get("/api/openapi.json", docsHelmet, (_req, res) => {
    res.json(openApiSpec);
  });
  app.use(
    "/api/docs",
    docsHelmet,
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: "Atomic Commits API",
      swaggerOptions: { persistAuthorization: false, displayRequestDuration: true },
    }),
  );

  app.use(helmet());
  app.use(express.json({ limit: "10kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  const configured = Boolean(
    options.databaseUrl?.trim() &&
    options.jwtSecret &&
    options.jwtSecret.trim().length >= 32,
  );

  /* make pool if configged, then wire the jwt auth routes */
  /* set when payments are configured; used for crash recovery at startup */
  let redemptions: OfflineRedemptionService | undefined;
  let grants: PaymentGrantService | undefined;
  const pool = configured
    ? createDatabasePool(options.databaseUrl!)
    : undefined;
  const tokens = pool ? createAccessTokenService(options.jwtSecret!) : undefined;
  const refreshTokens = pool ? createRefreshTokenService(pool) : undefined;
  let encryption: DataEncryption | undefined;
  let keyring: ReturnType<typeof parseDataEncryptionKeyring> | undefined;
  if (pool) {
    try {
      keyring = parseDataEncryptionKeyring({
        DATA_ENCRYPTION_KEY: options.dataEncryptionKey,
        DATA_ENCRYPTION_KEY_VERSION: options.dataEncryptionKeyVersion,
        DATA_ENCRYPTION_KEY_V1: options.dataEncryptionKeyV1,
      });
      encryption = createDataEncryption(keyring.keys, keyring.currentVersion);
    } catch {
      encryption = undefined;
    }
  }
  let google: GoogleOAuthService | undefined;
  if (options.googleAuthEnabled && pool && tokens && refreshTokens && encryption && options.googleClientId && options.googleClientSecret && options.publicBaseUrl) {
    try {
      google = createGoogleOAuthService({
        pool, tokens, refreshTokens, encryption, clientId: options.googleClientId,
        clientSecret: options.googleClientSecret, publicBaseUrl: options.publicBaseUrl,
      });
    } catch {
      google = undefined;
    }
  }
  let readiness: Promise<boolean> | undefined;
  let readinessExpiresAt = 0;
  function googleReady(): Promise<boolean> {
    if (!google || !pool) return Promise.resolve(false);
    if (readiness && Date.now() < readinessExpiresAt) return readiness;
    readinessExpiresAt = Date.now() + 5_000;
    readiness = pool.query<{ ready: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM app_private.schema_migrations WHERE version = $1)
        AND EXISTS (SELECT 1 FROM app_private.schema_migrations WHERE version = $2)
        AND to_regclass('app_private.google_oauth_identities') IS NOT NULL
        AND to_regclass('app_private.google_oauth_attempts') IS NOT NULL
        AND to_regclass('app_private.google_oauth_link_limits') IS NOT NULL
        AND to_regclass('app_private.google_oauth_link_account_limits') IS NOT NULL
        AND to_regclass('app_private.refresh_tokens') IS NOT NULL AS ready`,
      ["007_google_oauth.sql", "008_refresh_tokens.sql"],
    ).then((result) => result.rows[0]?.ready === true).catch(() => false);
    return readiness;
  }
  app.get(`${googleOAuthPath}/status`, async (_req, res) => {
    res.json({ enabled: await googleReady() });
  });
  if (google) {
    app.use(googleOAuthPath, async (_req, res, next) => {
      if (!await googleReady()) {
        res.status(503).json({ error: "Google sign-in is not available yet." });
        return;
      }
      next();
    });
    app.use(googleOAuthPath, createGoogleOAuthRouter(google));
  } else {
    app.use(googleOAuthPath, (_req, res) => {
      res.status(503).json({ error: "Google sign-in is not configured yet." });
    });
  }
  app.use("/api/auth", createAuthRateLimiter());

  if (pool && tokens) {
    const users = createUserRepository(pool);
    let emailVerification = options.emailVerification;
    if (!emailVerification) {
      try {
        if (options.supabaseUrl && options.supabasePublishableKey) {
          emailVerification = createSupabaseEmailVerification(options.supabaseUrl, options.supabasePublishableKey);
        }
      } catch {
        emailVerification = undefined;
      }
    }
    const controller = createAuthController(users, tokens, emailVerification, refreshTokens);
    app.use("/api/auth", createAuthRouter(controller, tokens));

    /* device enrollment needs the encryption key on top of auth */
    app.use("/api/devices", (_req, res, next) => {
      res.setHeader("Cache-Control", "no-store");
      next();
    });
    for (const path of ["/api/offline-redemptions", "/api/payments", "/api/payment-grants", "/api/open-payments", "/api/wallet", "/api/merchant"]) {
      app.use(path, (_req, res, next) => {
        res.setHeader("Cache-Control", "no-store");
        next();
      });
    }
    if (encryption && keyring) {
      const authorities = createGrantAuthorityStore(encryption);
      const devices = createTotpEnrollmentService({ pool, encryption, authorities });
      app.use("/api/devices", createTotpDevicesRouter(createTotpDevicesController(devices), tokens));

      const provider = options.redemptionProvider ?? createOpenPaymentsRedemptionProvider();
      const wallets = createVerifiedWalletService({
        pool, encryption, walletProvider: provider,
        verificationProvider: options.walletVerificationProvider ?? createWalletVerificationProvider(),
        publicBaseUrl: options.publicBaseUrl,
      });
      app.use("/api", createWalletsRouter(wallets, tokens));
      redemptions = createOfflineRedemptionService({
        pool,
        encryption,
        authorities,
        provider,
        dataKeys: keyring.keys,
        confirmTimeoutMs: options.confirmTimeoutMs,
        confirmPollMs: options.confirmPollMs,
        log: options.log ?? logEvent,
        allowedDriftSteps: options.allowedDriftSteps,
        now: options.redemptionNow,
      });
      grants = createPaymentGrantService({ pool, authorities, provider, availableKeyVersions: [...keyring.keys.keys()], log: options.log ?? logEvent });
      const approvals = createPaymentGrantApprovalService({
        pool,
        encryption,
        authorities,
        provider,
        publicBaseUrl: options.publicBaseUrl,
        log: options.log ?? logEvent,
      });
      app.use(
        "/api",
        createPaymentsRouter(createPaymentsController(redemptions), createPaymentGrantsController(grants, approvals), tokens),
      );
    } else {
      for (const path of ["/api/devices", "/api/offline-redemptions", "/api/payments", "/api/payment-grants", "/api/wallet", "/api/merchant"]) {
        app.use(path, (_req, res) => {
          res.status(503).json({ error: "Device enrollment and payments are not configured yet." });
        });
      }
    }
  } else {
    app.use("/api/auth", (_req, res) => {
      res.status(503).json({ error: "Authentication is not configured yet." });
    });
    for (const path of ["/api/devices", "/api/offline-redemptions", "/api/payments", "/api/payment-grants", "/api/wallet", "/api/merchant"]) {
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
    /* retries provider cancellation of locally revoked grants; undefined when payments are off */
    reconcileRevocations: () => grants?.retryPendingRevocations(),
    pruneGoogleAttempts: async () => {
      if (await googleReady()) await google?.pruneAttempts();
    },
    async close(): Promise<void> {
      await pool?.end();
    },
  };
}
