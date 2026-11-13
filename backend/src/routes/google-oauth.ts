import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import type { GoogleOAuthService } from "../services/google-oauth";

const completionPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to Atomic Commits</title></head><body>
<h1>Return to Atomic Commits</h1>
<p>The Google sign-in step has finished. Return to the app to check the result.</p>
<p>If you closed sign-in or it expired, start again in the app. You can close this browser tab.</p>
</body></html>`;

export function createGoogleOAuthRouter(service: GoogleOAuthService): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    next();
  });

  const limit = (requests: number, windowMs: number) => rateLimit({
    windowMs,
    limit: requests,
    ipv6Subnet: 56,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many Google sign-in requests. Wait before trying again.", code: "GOOGLE_RATE_LIMITED" },
  });
  // An aggregate abuse ceiling, not a per-person quota: many users may share a NAT.
  router.post("/attempts", limit(300, 15 * 60 * 1000), async (_req, res) => {
    res.status(201).json(await service.start());
  });

  // 30 polls/minute is normal. Allow NAT sharing here; the service separately
  // enforces a durable 60/minute budget per authenticated attempt.
  router.post("/attempts/:attemptId/consume", limit(600, 60 * 1000), async (req, res) => {
    const body: unknown = req.body;
    const pollSecret = typeof body === "object" && body !== null && "pollSecret" in body ? body.pollSecret : undefined;
    const result = await service.consume({ attemptId: req.params.attemptId, pollSecret });
    if (result.status === "rate_limited") {
      res.setHeader("Retry-After", String(result.retryAfterSeconds));
      res.status(429).json(result);
      return;
    }
    if (result.status === "pending") res.setHeader("Retry-After", String(result.pollIntervalMs / 1000));
    res.status(result.status === "pending" ? 202 : 200).json(result);
  });

  router.post("/attempts/:attemptId/link", limit(10, 15 * 60 * 1000), async (req, res) => {
    const body: unknown = req.body;
    const pollSecret = typeof body === "object" && body !== null && "pollSecret" in body ? body.pollSecret : undefined;
    const password = typeof body === "object" && body !== null && "password" in body ? body.password : undefined;
    const confirmLink = typeof body === "object" && body !== null && "confirmLink" in body ? body.confirmLink : undefined;
    const result = await service.link({ attemptId: req.params.attemptId, pollSecret, password, confirmLink }, req.ip);
    switch (result.status) {
      case "ready":
        res.status(200);
        break;
      case "invalid_password":
        res.status(401);
        break;
      case "rate_limited":
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        res.status(429);
        break;
      case "failed":
        res.status(409);
        break;
      default:
        res.status(410);
    }
    res.json(result);
  });

  router.post("/attempts/:attemptId/cancel", limit(30, 60 * 1000), async (req, res) => {
    const body: unknown = req.body;
    const pollSecret = typeof body === "object" && body !== null && "pollSecret" in body ? body.pollSecret : undefined;
    res.json(await service.cancel({ attemptId: req.params.attemptId, pollSecret }));
  });

  router.get("/callback", limit(60, 60 * 1000), async (req, res) => {
    try {
      await service.callback(req.query);
    } catch {
      // Browser responses disclose neither account state nor infrastructure errors.
      // The initiating client can retry polling or start again after expiry.
    }
    res.redirect(303, service.completionUrl);
  });
  router.get("/complete", (_req, res) => {
    res.type("html").send(completionPage);
  });

  return router;
}
