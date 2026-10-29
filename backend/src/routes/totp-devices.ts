import { Router } from "express";
import { rateLimit } from "express-rate-limit";

import type { TotpDevicesController } from "../controllers/totp-devices";
import { createRequireLogin } from "../middleware/require-login";
import type { AccessTokenService } from "../services/tokens";

export function createTotpDevicesRouter(
  controller: TotpDevicesController,
  tokens: AccessTokenService,
): Router {
  const router = Router();
  router.use(createRequireLogin(tokens));
  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 60,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Please try again later." },
    }),
  );

  router.post("/totp/enroll", controller.enroll);
  router.get("/totp/:prefix/status", controller.status);
  router.post("/totp/:prefix/revoke", controller.revoke);

  return router;
}
