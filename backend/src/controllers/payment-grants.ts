import type { RequestHandler } from "express";

import { ApiError } from "../errors/api-error";
import type { PaymentGrantApprovalService } from "../services/payment-grant-approval";
import type { PaymentGrantService } from "../services/payment-grants";

function requireUserId(userId: number | undefined): number {
  if (userId === undefined) throw new ApiError(401, "Please log in first");
  return userId;
}

export function createPaymentGrantsController(service: PaymentGrantService, approvals: PaymentGrantApprovalService) {
  const list: RequestHandler = async (req, res) => {
    res.json({ grants: await service.listGrants(requireUserId(req.userId)) });
  };
  const get: RequestHandler = async (req, res) => {
    res.json(await service.getGrant(requireUserId(req.userId), req.params.grantId));
  };
  const revoke: RequestHandler = async (req, res) => {
    res.json(await service.revokeGrant(requireUserId(req.userId), req.params.grantId));
  };
  /* POST /api/payment-grants - start server-side payer consent, returns the approval link */
  const start: RequestHandler = async (req, res) => {
    const approval = await approvals.startApproval(requireUserId(req.userId), req.body);
    res.setHeader("Location", `/api/payment-grants/approvals/${approval.approvalId}`);
    res.status(202).json(approval);
  };
  /* GET /api/payment-grants/approvals/:approvalId - poll the outcome */
  const approval: RequestHandler = async (req, res) => {
    res.json(await approvals.getApproval(requireUserId(req.userId), req.params.approvalId));
  };
  /* GET /api/open-payments/callback/:approvalId - the wallet's browser redirect (no app login) */
  const callback: RequestHandler = async (req, res) => {
    const result = await approvals.handleCallback(req.params.approvalId, req.query as Record<string, unknown>);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.status(result.status).type("text/plain; charset=utf-8").send(result.message);
  };
  return { list, get, revoke, start, approval, callback };
}

export type PaymentGrantsController = ReturnType<typeof createPaymentGrantsController>;
