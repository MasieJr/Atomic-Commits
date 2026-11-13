import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import { createRequireLogin } from "../middleware/require-login";
import type { AccessTokenService } from "../services/tokens";
import type { VerifiedWalletService } from "../services/verified-wallets";

export function createWalletsRouter(wallets: VerifiedWalletService, tokens: AccessTokenService): Router {
  const router = Router();
  const requireLogin = createRequireLogin(tokens);
  const perUser = rateLimit({
    windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false,
    keyGenerator: (req) => `user:${req.userId}`,
    message: { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
  });
  router.get("/wallet", requireLogin, perUser, async (req, res) => {
    res.json({ wallet: await wallets.getWallet(req.userId!) });
  });
  router.post("/wallet/approvals", requireLogin, perUser, async (req, res) => {
    res.status(202).json(await wallets.start(req.userId!, req.body));
  });
  router.get("/wallet/approvals/:id", requireLogin, perUser, async (req, res) => {
    res.json(await wallets.getApproval(req.userId!, req.params.id));
  });
  router.post("/merchant", requireLogin, perUser, async (req, res) => {
    res.json(await wallets.setupMerchant(req.userId!, req.body));
  });
  router.get("/wallet/callback/:id", rateLimit({
    windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false,
  }), async (req, res) => {
    const result = await wallets.callback(req.params.id, req.query);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.status(result.status).type("text/plain").send(result.message);
  });
  return router;
}
