import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import type { PaymentGrantsController } from "../controllers/payment-grants";
import type { PaymentsController } from "../controllers/payments";
import { createRequireLogin } from "../middleware/require-login";
import type { AccessTokenService } from "../services/tokens";

/* mounted at /api: /offline-redemptions, /payments, /payment-grants */
export function createPaymentsRouter(
  controller: PaymentsController,
  grants: PaymentGrantsController,
  tokens: AccessTokenService,
): Router {
  const router = Router();
  const requireLogin = createRequireLogin(tokens);
  const perUser = (limit: number) =>
    rateLimit({
      windowMs: 60 * 1000,
      limit,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      /* runs after requireLogin, so the verified user id is the key */
      keyGenerator: (req) => `user:${req.userId}`,
      message: { error: "Too many requests. Please slow down.", code: "RATE_LIMITED" },
    });

  /* code guessing protection: at most 20 redemption attempts per merchant per minute */
  router.post("/offline-redemptions", requireLogin, perUser(20), controller.redeem);
  router.get("/payments", requireLogin, perUser(120), controller.list);
  router.get("/payments/:paymentId", requireLogin, perUser(120), controller.get);

  router.post("/payment-grants", requireLogin, perUser(10), grants.start);
  router.get("/payment-grants/approvals/:approvalId", requireLogin, perUser(120), grants.approval);
  router.get("/payment-grants", requireLogin, perUser(120), grants.list);
  router.get("/payment-grants/:grantId", requireLogin, perUser(120), grants.get);
  router.delete("/payment-grants/:grantId", requireLogin, perUser(20), grants.revoke);
  /* public: the payer's browser arrives here from the wallet, without an app token */
  router.get(
    "/open-payments/callback/:approvalId",
    rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }),
    grants.callback,
  );
  return router;
}
