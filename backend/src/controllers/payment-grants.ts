import type { RequestHandler } from "express";

import { ApiError } from "../errors/api-error";
import type { PaymentGrantService } from "../services/payment-grants";

function requireUserId(userId: number | undefined): number {
  if (userId === undefined) throw new ApiError(401, "Please log in first");
  return userId;
}

export function createPaymentGrantsController(service: PaymentGrantService) {
  const list: RequestHandler = async (req, res) => {
    res.json({ grants: await service.listGrants(requireUserId(req.userId)) });
  };
  const get: RequestHandler = async (req, res) => {
    res.json(await service.getGrant(requireUserId(req.userId), req.params.grantId));
  };
  const revoke: RequestHandler = async (req, res) => {
    res.json(await service.revokeGrant(requireUserId(req.userId), req.params.grantId));
  };
  return { list, get, revoke };
}

export type PaymentGrantsController = ReturnType<typeof createPaymentGrantsController>;
