import { Router } from "express";
import { rateLimit } from "express-rate-limit";

export function createAuthRateLimiter(): Router {
  const router = Router();
  const limit = (requests: number) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: requests,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        error: "Too many authentication attempts. Please try again later.",
      },
    });
  /* 60 requests overall on /auth and 10 per 15m on login, 5 per 15m on register */
  router.use(limit(60));
  router.post("/login", limit(10));
  router.post("/register", limit(5));

  return router;
}
