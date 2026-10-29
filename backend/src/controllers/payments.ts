import type { RequestHandler } from "express";

import { ApiError } from "../errors/api-error";
import type { OfflineRedemptionService } from "../services/offline-redemption";

function requireUserId(userId: number | undefined): number {
  if (userId === undefined) throw new ApiError(401, "Please log in first");
  return userId;
}

export function createPaymentsController(service: OfflineRedemptionService) {
  /* POST /api/offline-redemptions - merchant only */
  const redeem: RequestHandler = async (req, res) => {
    const { payment, created } = await service.redeem({
      userId: requireUserId(req.userId),
      idempotencyKey: req.get("idempotency-key"),
      body: req.body,
    });
    res.setHeader("Location", `/api/payments/${payment.paymentId}`);
    /* 202 for a new attempt, 200 when replaying an earlier identical request */
    res.status(created ? 202 : 200).json(payment);
  };

  /* GET /api/payments/:paymentId - payer or merchant of that payment */
  const get: RequestHandler = async (req, res) => {
    res.json(await service.getPayment(requireUserId(req.userId), req.params.paymentId));
  };

  /* GET /api/payments - the caller's receipts, as payer and as merchant */
  const list: RequestHandler = async (req, res) => {
    res.json(await service.listPayments(requireUserId(req.userId)));
  };

  return { redeem, get, list };
}

export type PaymentsController = ReturnType<typeof createPaymentsController>;
