import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import type { PaymentsController } from "../controllers/payments";
import { createRequireLogin } from "../middleware/require-login";
import type { AccessTokenService } from "../services/tokens";

/* mounted at /api; exposes /offline-redemptions and /payments/:paymentId */
export function createPaymentsRouter(controller: PaymentsController, tokens: AccessTokenService): Router {
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
  router.get("/payments/:paymentId", requireLogin, perUser(120), controller.get);
  return router;
}
