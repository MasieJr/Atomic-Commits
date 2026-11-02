import type { RequestHandler } from "express";

import { ApiError } from "../errors/api-error";
import type { TotpEnrollmentService } from "../services/totp-enrollment";

function requireUserId(userId: number | undefined): number {
  /* requireLogin already ran; this only narrows the type */
  if (userId === undefined) throw new ApiError(401, "Please log in first");
  return userId;
}

export function createTotpDevicesController(service: TotpEnrollmentService) {
  const enroll: RequestHandler = async (req, res) => {
    const body = typeof req.body === "object" && req.body !== null && !Array.isArray(req.body) ? req.body : {};
    const packet = await service.enrollDevice(requireUserId(req.userId), body.authorizationId, body.deviceName);
    /* the one-time secret: never cacheable, never logged */
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(packet);
  };

  const status: RequestHandler = async (req, res) => {
    res.json(await service.getStatus(requireUserId(req.userId), req.params.prefix));
  };

  const revoke: RequestHandler = async (req, res) => {
    res.json(await service.revokeDevice(requireUserId(req.userId), req.params.prefix));
  };

  return { enroll, status, revoke };
}

export type TotpDevicesController = ReturnType<typeof createTotpDevicesController>;
