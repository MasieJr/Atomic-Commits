/*
 * OpenAPI 3.0 description of the Atomic Commits API, served as Swagger UI at
 * /api/docs and as JSON at /api/openapi.json (usable for client codegen).
 * Keep it in sync with the routes: test/api-docs.test.ts checks coverage.
 */

const money = { $ref: "#/components/schemas/Money" };
const error = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});
const json = (schema: object, description = "OK") => ({
  description,
  content: { "application/json": { schema } },
});
const uuidParam = (name: string, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema: { type: "string", format: "uuid" },
});
const bearer = [{ bearerAuth: [] }];

export function buildOpenApiSpec(serverUrl?: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "Atomic Commits API",
      version: "0.2.0",
      description: [
        "Offline payments on Open Payments (Interledger Test Wallet).",
        "",
        "**Flow:** register/login -> verify wallet ownership -> approve a spending grant -> enroll a device ->",
        "the offline device shows `PREFIX-123456` -> an online merchant redeems it -> check the payment.",
        "",
        "The server never holds money: it validates the code and sends the payment straight from the payer's",
        "wallet to the merchant's wallet, within limits the payer approved.",
        "",
        "**Money** is always exact integer minor units as a string: `{ value: \"500\", assetCode: \"EUR\", assetScale: 2 }` = €5.00.",
        "",
        "**Auth:** click *Authorize* and paste the `token` from register/login (no `Bearer ` prefix).",
      ].join("\n"),
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    tags: [
      { name: "Auth" },
      { name: "Google Auth", description: "Google sign-in using a one-time, app-polled handoff to the local JWT auth system" },
      { name: "Wallets", description: "Per-user wallet ownership and merchant setup" },
      { name: "Grants", description: "Payer spending approvals (bounded, revocable)" },
      { name: "Devices", description: "TOTP enrollment for the offline payer device" },
      { name: "Payments", description: "Merchant redemption, status and receipts" },
      { name: "Health" },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: {
        Money: {
          type: "object",
          required: ["value", "assetCode", "assetScale"],
          properties: {
            value: { type: "string", pattern: "^(0|[1-9][0-9]{0,17})$", example: "500", description: "Integer minor units" },
            assetCode: { type: "string", example: "EUR" },
            assetScale: { type: "integer", example: 2 },
          },
        },
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string", description: "Human-readable, safe to show" },
            code: {
              type: "string",
              description: "Stable machine code when available",
              example: "CODE_ALREADY_USED",
            },
          },
        },
        User: {
          type: "object",
          properties: { id: { type: "integer" }, name: { type: "string" }, email: { type: "string", format: "email" } },
        },
        AuthResponse: {
          type: "object",
          properties: {
            message: { type: "string" },
            user: { $ref: "#/components/schemas/User" },
            token: { type: "string", description: "Bearer token, valid 15 minutes; renew with POST /api/auth/refresh" },
            refreshToken: { type: "string", description: "Opaque rotating session token, valid 30 days; keep it private" },
          },
        },
        Approval: {
          type: "object",
          properties: {
            approvalId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["AWAITING_APPROVAL", "FINISHING", "APPROVED", "DENIED", "FAILED", "EXPIRED"] },
            payerWalletAddress: { type: "string" },
            authorizationUrl: { type: "string", description: "Provider consent URL, returned when approval starts" },
            cumulativeCap: money,
            perPaymentMaxDebit: money,
            expiresAt: { type: "string", format: "date-time" },
            authorizationId: { type: "string", format: "uuid", description: "Present once APPROVED: use it to enroll a device" },
            errorCode: { type: "string" },
          },
        },
        Grant: {
          type: "object",
          properties: {
            authorizationId: { type: "string", format: "uuid" },
            status: { type: "string", enum: ["ACTIVE", "ROTATING", "BLOCKED", "REAUTHORIZATION_REQUIRED", "REVOKED", "EXPIRED"] },
            authoritySource: { type: "string", enum: ["PROVIDER", "DEMO_PLACEHOLDER"] },
            payerWalletAddress: { type: "string" },
            cumulativeCap: money,
            perPaymentMaxDebit: money,
            spent: money,
            reserved: money,
            remaining: money,
            validUntil: { type: "string", format: "date-time" },
            providerRevocation: {
              type: "string",
              enum: ["NONE", "NOT_REQUIRED", "PENDING", "CONFIRMED", "DEFERRED_UNRESOLVED_PAYMENTS", "FAILED"],
            },
            revokedAt: { type: "string", format: "date-time" },
          },
        },
        EnrollmentPacket: {
          type: "object",
          description:
            "Returned ONCE. Exactly these fields (the offline client rejects extras). Store `secret` securely on the device; it is never returned again.",
          properties: {
            version: { type: "integer", enum: [1] },
            prefix: { type: "string", pattern: "^[A-Z0-9]{4,12}$", example: "K7PQ3M" },
            secret: { type: "string", description: "Base32 TOTP secret (160 bits)" },
            algorithm: { type: "string", enum: ["SHA1"] },
            digits: { type: "integer", enum: [6] },
            periodSeconds: { type: "integer", enum: [30] },
            expiresAtEpochMs: { type: "integer" },
            revoked: { type: "boolean", enum: [false] },
          },
        },
        DeviceStatus: {
          type: "object",
          properties: {
            prefix: { type: "string" },
            deviceName: { type: "string" },
            status: { type: "string", enum: ["ACTIVE", "REVOKED"] },
            authorizationId: { type: "string", format: "uuid" },
            grantStatus: { type: "string" },
            expiresAtEpochMs: { type: "integer" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Payment: {
          type: "object",
          properties: {
            paymentId: { type: "string", format: "uuid" },
            status: {
              type: "string",
              enum: ["AWAITING_AUTHORIZATION", "SUBMITTING", "PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN", "REJECTED"],
              description:
                "UNKNOWN = outcome unclear; the budget stays held and the server reconciles it. Never retry a payment yourself.",
            },
            merchantName: { type: "string" },
            payerName: { type: "string" },
            merchantReceiveRequested: money,
            payerDebitQuoted: money,
            payerDebitPaid: { ...money, description: "Receipt: provider-confirmed, only when SUCCEEDED" },
            merchantReceivePaid: { ...money, description: "Receipt: provider-confirmed, only when SUCCEEDED" },
            completedAt: { type: "string", format: "date-time" },
            providerIncomingRef: { type: "string", description: "Provider receipt reference, only when SUCCEEDED" },
            providerOutgoingRef: { type: "string", description: "Provider outgoing payment reference, only when SUCCEEDED" },
            errorCode: {
              type: "string",
              example: "QUOTE_EXCEEDS_LIMIT",
              description: "e.g. QUOTE_FAILED, QUOTE_EXCEEDS_LIMIT, PROVIDER_REJECTED, PROVIDER_FAILED, GRANT_NOT_SPENDABLE",
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    paths: {
      "/health": {
        get: { tags: ["Health"], summary: "Liveness check", responses: { 200: json({ type: "object", properties: { status: { type: "string", example: "ok" } } }) } },
      },
      "/api/auth/register": {
        post: {
          tags: ["Auth"],
          summary: "Create an account (returns a token right away)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["name", "email", "password", "emailCode"],
                  properties: {
                    name: { type: "string", minLength: 2, maxLength: 80 },
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8, description: "8+ characters, at most 72 bytes" },
                    emailCode: { type: "string", pattern: "^[0-9]{6,10}$", description: "Code sent to this email using POST /api/auth/email-code" },
                  },
                },
              },
            },
          },
          responses: {
            201: json({ $ref: "#/components/schemas/AuthResponse" }, "Created"),
            400: error("Invalid input"),
            409: error("Email already registered"),
            429: error("Too many attempts (5 per 15 minutes)"),
          },
        },
      },
      "/api/auth/email-code": {
        post: {
          tags: ["Auth"],
          summary: "Send an email verification code for registration",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["email"], properties: { email: { type: "string", format: "email", maxLength: 254 } },
          } } } },
          responses: {
            202: json({ type: "object", properties: { message: { type: "string", example: "Check your email for a verification code." } } }, "Verification email requested"),
            400: error("Invalid email address"),
            429: error("Email provider rate limit or too many requests (5 per 15 minutes)"),
            503: error("Email verification is unavailable or not configured"),
          },
        },
      },
      "/api/auth/google/status": {
        get: { tags: ["Google Auth"], summary: "Check Google sign-in configuration availability", description: "Reports configuration only; it does not verify database, Google, or migration readiness. Returns enabled false when Google sign-in is unavailable.", responses: { 200: json({ type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } }) } },
      },
      "/api/auth/google/attempts": {
        post: { tags: ["Google Auth"], summary: "Start Google sign-in", description: "Open the returned authorizationUrl in the system browser. Keep attemptId and pollSecret private to this app instance. No bearer token is required.", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: {} } } } }, responses: {
          201: json({ type: "object", required: ["attemptId", "pollSecret", "authorizationUrl", "expiresAt", "pollIntervalMs"], properties: { attemptId: { type: "string", format: "uuid" }, pollSecret: { type: "string", description: "Private handoff proof; do not expose in URLs or logs" }, authorizationUrl: { type: "string", format: "uri" }, expiresAt: { type: "string", format: "date-time" }, pollIntervalMs: { type: "integer", example: 2000 } } }, "Attempt created"),
          429: error("Too many Google sign-in requests (10 per 15 minutes per IP bucket)"), 503: error("Google sign-in is unavailable") } },
      },
      "/api/auth/google/attempts/{attemptId}/consume": {
        post: { tags: ["Google Auth"], summary: "Poll and consume a Google sign-in attempt", description: "Poll no faster than pollIntervalMs. A successful complete result returns a local JWT once; do not expect replay recovery.", parameters: [uuidParam("attemptId", "Attempt ID from start")], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["pollSecret"], properties: { pollSecret: { type: "string", description: "Secret returned by start" } } } } } }, responses: {
          200: json({ type: "object", properties: { status: { type: "string", enum: ["complete", "link_required", "cancelled", "expired", "consumed", "failed"] }, user: { $ref: "#/components/schemas/User" }, token: { type: "string", description: "Local JWT, only on complete" }, attemptsRemaining: { type: "integer" }, expiresAt: { type: "string", format: "date-time" }, code: { type: "string" } } }, "Attempt result"),
          202: json({ type: "object", required: ["status", "pollIntervalMs"], properties: { status: { type: "string", enum: ["pending"] }, pollIntervalMs: { type: "integer", example: 2000 } } }, "Attempt is pending; Retry-After is set"),
          400: error("Malformed attempt proof"), 404: error("Attempt unavailable or poll secret incorrect"), 429: error("Consume poll budget exhausted; Retry-After is set"), 503: error("Google sign-in storage unavailable") } },
      },
      "/api/auth/google/attempts/{attemptId}/link": {
        post: { tags: ["Google Auth"], summary: "Connect Google to an existing account using password proof", description: "Only for a link_required attempt. This endpoint never returns a token; after ready, poll consume. Confirm explicitly.", parameters: [uuidParam("attemptId", "Attempt ID from start")], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["pollSecret", "password", "confirmLink"], properties: { pollSecret: { type: "string" }, password: { type: "string", minLength: 8, description: "Fresh local Atomic Commits password; at most 72 UTF-8 bytes" }, confirmLink: { type: "boolean", enum: [true] } } } } } }, responses: {
          200: json({ type: "object", properties: { status: { type: "string", enum: ["ready"] } } }, "Password proof accepted; poll consume to retrieve the session"),
          400: error("Malformed proof or GOOGLE_LINK_CONFIRMATION_REQUIRED"), 401: json({ type: "object", properties: { status: { type: "string", enum: ["invalid_password"] }, attemptsRemaining: { type: "integer" } } }, "Password proof rejected"), 409: json({ type: "object", properties: { status: { type: "string", enum: ["failed"] }, code: { type: "string", enum: ["link_attempts_exhausted", "link_conflict"] } } }, "Link failed or attempt is not awaiting linking"), 410: error("Attempt expired, cancelled, or consumed"), 429: error("Link rate limited; Retry-After is set"), 503: error("Google account linking unavailable") } },
      },
      "/api/auth/google/attempts/{attemptId}/cancel": {
         post: { tags: ["Google Auth"], summary: "Cancel a Google sign-in attempt", parameters: [uuidParam("attemptId", "Attempt ID from start")], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["pollSecret"], properties: { pollSecret: { type: "string" } } } } } }, responses: { 200: json({ type: "object", properties: { status: { type: "string", enum: ["cancelled", "consumed", "expired", "failed"] } } }), 400: error("Malformed attempt proof"), 404: error("Attempt unavailable or poll secret incorrect"), 503: error("Google sign-in storage unavailable") } },
      },
      "/api/auth/login": {
        post: {
          tags: ["Auth"],
          summary: "Log in",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
                },
              },
            },
          },
          responses: {
            200: json({ $ref: "#/components/schemas/AuthResponse" }),
            401: error("Invalid email or password"),
            429: error("Too many attempts (10 per 15 minutes)"),
          },
        },
      },
      "/api/auth/me": {
        get: {
          tags: ["Auth"],
          summary: "Current user",
          security: bearer,
          responses: { 200: json({ type: "object", properties: { user: { $ref: "#/components/schemas/User" } } }), 401: error("Not logged in") },
        },
      },
      "/api/auth/refresh": {
        post: {
          tags: ["Auth"],
          summary: "Exchange a refresh token for a new token pair",
          description: "Rotates the refresh token: the presented one is revoked and a new pair is returned. Reusing a rotated token revokes every session for that user.",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["refreshToken"], properties: { refreshToken: { type: "string" } } } } },
          },
          responses: {
            200: json({ $ref: "#/components/schemas/AuthResponse" }),
            401: error("Refresh token invalid, expired, or already used"),
            429: error("Too many attempts (30 per 15 minutes)"),
            503: error("Sessions are not configured"),
          },
        },
      },
      "/api/auth/logout": {
        post: {
          tags: ["Auth"],
          summary: "Log out (revokes the refresh token in the body)",
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { refreshToken: { type: "string" } } } } } },
          responses: { 200: json({ type: "object", properties: { message: { type: "string" } } }) },
        },
      },
      "/api/wallet": {
        get: {
          tags: ["Wallets"], summary: "Get the signed-in user's default spending wallet (legacy API)", security: bearer,
          responses: { 200: json({ type: "object", properties: { wallet: { type: "object", nullable: true, properties: {
            address: { type: "string" }, publicName: { type: "string", nullable: true },
            assetCode: { type: "string" }, assetScale: { type: "integer" }, verifiedAt: { type: "string", format: "date-time" },
          } } } }), 401: error("Not logged in") },
        },
      },
      "/api/wallets": {
        get: { tags: ["Wallets"], summary: "List verified wallets and their defaults", security: bearer,
          responses: { 200: json({ type: "object", properties: { wallets: { type: "array", items: {
            type: "object", properties: {
              address: { type: "string" }, publicName: { type: "string", nullable: true },
              assetCode: { type: "string" }, assetScale: { type: "integer" }, verifiedAt: { type: "string", format: "date-time" },
              isDefaultSpending: { type: "boolean" }, isDefaultReceiving: { type: "boolean" },
            },
          } } } }), 401: error("Not logged in") } },
      },
      "/api/wallets/approvals": {
        post: { tags: ["Wallets"], summary: "Start verification of an additional wallet", security: bearer,
          description: "Complete the provider approval and poll the existing /api/wallet/approvals/{id} endpoint.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["walletAddress"], properties: { walletAddress: { type: "string" } },
          } } } },
          responses: { 202: json({ type: "object", properties: {
            approvalId: { type: "string", format: "uuid" }, status: { type: "string" }, authorizationUrl: { type: "string" },
          } }), 409: error("Wallet already linked"), 422: error("Wallet not found") } },
      },
      "/api/wallets/default": {
        post: { tags: ["Wallets"], summary: "Choose a verified default wallet", security: bearer,
          description: "Changing spending defaults does not change existing device grants. A receiving default updates an existing merchant destination atomically. Legacy payments pending at cutover block changes until manually resolved, including after they become terminal; terminal-at-cutover history does not block changes.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["walletAddress", "purpose"], properties: {
              walletAddress: { type: "string" }, purpose: { type: "string", enum: ["spending", "receiving"] },
            },
          } } } },
          responses: { 200: json({ type: "object", properties: { wallets: { type: "array", items: { type: "object" } } } }),
            400: error("Invalid input"), 404: error("Verified wallet not found"), 409: error("A legacy payment pending at cutover blocks a receiving destination change") } },
      },
      "/api/wallet/approvals": {
        post: {
          tags: ["Wallets"], summary: "Start interactive wallet ownership verification", security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["walletAddress"], properties: { walletAddress: { type: "string" } },
          } } } },
          responses: { 202: json({ type: "object", properties: {
            approvalId: { type: "string", format: "uuid" }, status: { type: "string" }, authorizationUrl: { type: "string" },
          } }, "Open the provider authorization URL"), 409: error("A wallet is already linked"), 422: error("Wallet not found") },
        },
      },
      "/api/wallet/approvals/{id}": {
        get: { tags: ["Wallets"], summary: "Check your wallet verification", security: bearer,
          parameters: [uuidParam("id", "Wallet verification ID")],
          responses: { 200: json({ type: "object", properties: {
            approvalId: { type: "string" }, status: { type: "string", enum: ["AWAITING_APPROVAL", "FINISHING", "VERIFIED", "FAILED", "EXPIRED"] }, walletAddress: { type: "string" },
          } }), 404: error("Verification not found") } },
      },
      "/api/wallet/callback/{id}": {
        get: { tags: ["Wallets"], summary: "Provider's wallet ownership callback", parameters: [uuidParam("id", "Wallet verification ID")],
          responses: { 200: { description: "Ownership verified" }, 400: { description: "Callback verification failed" }, 409: { description: "Already handled" } } },
      },
      "/api/merchant": {
        get: { tags: ["Wallets"], summary: "Get the caller's receiving setup", security: bearer,
          responses: { 200: json({ type: "object", properties: { merchant: { type: "object", nullable: true, properties: {
            merchantId: { type: "string", format: "uuid" }, displayName: { type: "string" },
            walletAddress: { type: "string" }, status: { type: "string" },
          } } } }), 401: error("Not logged in") } },
        post: { tags: ["Wallets"], summary: "Activate merchant checkout using the default receiving wallet", security: bearer,
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["displayName"], properties: {
              displayName: { type: "string", minLength: 2, maxLength: 80 },
              createOnly: { type: "boolean", description: "Return an existing setup without changing it." },
            },
          } } } },
          responses: { 200: json({ type: "object", properties: {
            merchantId: { type: "string", format: "uuid" }, displayName: { type: "string" }, walletAddress: { type: "string" }, status: { type: "string" },
          } }), 409: error("A verified wallet is required") } },
      },
      "/api/payment-grants": {
        post: {
          tags: ["Grants"],
          summary: "Start a payer approval: returns the wallet link to open",
          description:
            "Open `authorizationUrl` in the payer's browser. After approval the wallet redirects to the server's callback, then poll the approval.",
          security: bearer,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    walletAddress: { type: "string", description: "Optional; if supplied it must equal the caller's default spending wallet." },
                    assetCode: { type: "string", description: "Reviewed spending asset code; supply together with assetScale. Omission is supported only for single-wallet legacy clients." },
                    assetScale: { type: "integer", description: "Reviewed spending asset scale; must match verified metadata and the provider." },
                    cumulativeCap: { type: "string", example: "50000", description: "Total limit, payer minor units (default 50000)" },
                    perPaymentMaxDebit: { type: "string", example: "5000", description: "Per payment, payer minor units (default 5000)" },
                  },
                },
              },
            },
          },
          responses: {
            202: json(
              { allOf: [{ $ref: "#/components/schemas/Approval" }, { type: "object", properties: { authorizationUrl: { type: "string", format: "uri" } } }] },
              "Approval started",
            ),
            400: error("Invalid input"),
            409: error("WALLET_ASSET_CHANGED or WALLET_REQUIRED"),
            422: error("WALLET_NOT_FOUND"),
            502: error("PROVIDER_UNAVAILABLE"),
            503: error("NOT_CONFIGURED (PUBLIC_BASE_URL missing)"),
          },
        },
        get: {
          tags: ["Grants"],
          summary: "My grants",
          security: bearer,
          responses: { 200: json({ type: "object", properties: { grants: { type: "array", items: { $ref: "#/components/schemas/Grant" } } } }) },
        },
      },
      "/api/payment-grants/approvals/{approvalId}": {
        get: {
          tags: ["Grants"],
          summary: "Poll an approval until APPROVED (then use authorizationId)",
          security: bearer,
          parameters: [uuidParam("approvalId", "From POST /api/payment-grants")],
          responses: { 200: json({ $ref: "#/components/schemas/Approval" }), 404: error("Not found (or not yours)") },
        },
      },
      "/api/payment-grants/{grantId}": {
        get: {
          tags: ["Grants"],
          summary: "One grant with spent / reserved / remaining",
          security: bearer,
          parameters: [uuidParam("grantId", "authorizationId")],
          responses: { 200: json({ $ref: "#/components/schemas/Grant" }), 404: error("Not found (or not yours)") },
        },
        delete: {
          tags: ["Grants"],
          summary: "Revoke: blocks new debits immediately, revokes devices, cancels at the provider",
          security: bearer,
          parameters: [uuidParam("grantId", "authorizationId")],
          responses: { 200: json({ $ref: "#/components/schemas/Grant" }), 404: error("Not found (or not yours)") },
        },
      },
      "/api/open-payments/callback/{approvalId}": {
        get: {
          tags: ["Grants"],
          summary: "Wallet redirect target (browser only, not for apps)",
          description: "Called by the payer's browser after approving in the wallet. No token. Verified with the GNAP hash.",
          parameters: [
            uuidParam("approvalId", "Approval id"),
            { name: "interact_ref", in: "query", schema: { type: "string" } },
            { name: "hash", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Approved (plain text page)" },
            400: { description: "Denied or not verifiable" },
            409: { description: "Already handled" },
            410: { description: "Expired" },
          },
        },
      },
      "/api/devices/totp": {
        get: { tags: ["Devices"], summary: "List the caller's enrolled devices without secrets", security: bearer,
          responses: { 200: json({ type: "object", properties: { devices: { type: "array", items: { $ref: "#/components/schemas/DeviceStatus" } } } }) } },
      },
      "/api/devices/totp/enroll": {
        post: {
          tags: ["Devices"],
          summary: "Enroll the offline device on an approved grant (one active device per grant)",
          security: bearer,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["authorizationId", "deviceName"],
                  properties: {
                    authorizationId: { type: "string", format: "uuid" },
                    deviceName: { type: "string", maxLength: 60, example: "Payer phone" },
                  },
                },
              },
            },
          },
          responses: {
            201: json({ $ref: "#/components/schemas/EnrollmentPacket" }, "One-time packet (Cache-Control: no-store)"),
            400: error("Invalid input"),
            404: error("Grant not found (or not yours)"),
            409: error("Grant not usable, or it already has an active device (revoke it first)"),
          },
        },
      },
      "/api/devices/totp/{prefix}/status": {
        get: {
          tags: ["Devices"],
          summary: "Device status (never returns the secret)",
          security: bearer,
          parameters: [{ name: "prefix", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: json({ $ref: "#/components/schemas/DeviceStatus" }), 404: error("Not found (or not yours)") },
        },
      },
      "/api/devices/totp/{prefix}/revoke": {
        post: {
          tags: ["Devices"],
          summary: "Revoke a device",
          security: bearer,
          parameters: [{ name: "prefix", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: json({ $ref: "#/components/schemas/DeviceStatus" }), 404: error("Not found (or not yours)") },
        },
      },
      "/api/offline-redemptions": {
        post: {
          tags: ["Payments"],
          summary: "Merchant redeems an offline code (one code = one payment)",
          description:
            "Merchant accounts only. Send a unique `Idempotency-Key` per purchase: retrying with the same key and body returns the original payment (200) and never pays twice. The server dual-tries the default 30-second TOTP window (plus adjacent drift windows) and an optional 30-minute long-code window (exactly one bucket, no drift) — the presented code carries no period. Each (device, period, time step) is accepted only once.",
          security: bearer,
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: true,
              schema: { type: "string", pattern: "^[A-Za-z0-9_-]{8,128}$" },
              example: "purchase-7f3a9c21",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["credentialType", "paymentCode", "merchantReceive"],
                  properties: {
                    credentialType: { type: "string", enum: ["totp-v1"] },
                    paymentCode: { type: "string", example: "K7PQ3M-482916" },
                    receivingWalletAddress: { type: "string", description: "Expected merchant destination. Required for new attempts when multiple wallets are linked; a changed default is rejected. Replays of new attempts must preserve whether the address was supplied and its value. For historical attempts of unknown request identity, omission is accepted and a supplied address must match the snapshot; a NULL snapshot cannot match." },
                    merchantReceive: { ...money, description: "What the merchant receives, in the merchant wallet's asset" },
                  },
                },
              },
            },
          },
          responses: {
            202: json({ $ref: "#/components/schemas/Payment" }, "New attempt (Location: /api/payments/{id}); check status"),
            200: json({ $ref: "#/components/schemas/Payment" }, "Replay of an earlier identical request"),
            400: error("INVALID_REQUEST or IDEMPOTENCY_KEY_REQUIRED"),
            403: error("NOT_A_MERCHANT"),
            409: error("CODE_ALREADY_USED, IDEMPOTENCY_CONFLICT, DEMO_GRANT, GRANT_NOT_SPENDABLE or INSUFFICIENT_GRANT_BUDGET"),
            422: error("CODE_INVALID (wrong, expired, unknown or revoked)"),
            429: error("RATE_LIMITED (20 per minute per merchant)"),
          },
        },
      },
      "/api/payments": {
        get: {
          tags: ["Payments"],
          summary: "My receipts, as payer and as merchant (latest 50 each)",
          security: bearer,
          responses: {
            200: json({
              type: "object",
              properties: {
                asPayer: { type: "array", items: { $ref: "#/components/schemas/Payment" } },
                asMerchant: { type: "array", items: { $ref: "#/components/schemas/Payment" } },
              },
            }),
          },
        },
      },
      "/api/payments/{paymentId}": {
        get: {
          tags: ["Payments"],
          summary: "Payment status / receipt (payer or merchant of that payment)",
          security: bearer,
          parameters: [uuidParam("paymentId", "From the redemption response")],
          responses: { 200: json({ $ref: "#/components/schemas/Payment" }), 404: error("Not found (or not yours)") },
        },
      },
    },
  };
}
