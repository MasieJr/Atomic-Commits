import type { CookieOptions, Request } from "express";
import "express-session";

import { AuthStorageError } from "../errors/auth";

declare module "express-session" {
  interface SessionData {
    userId?: number;
  }
}

export const sessionCookieName = "atomic.sid";

export function sessionCookieOptions(production: boolean): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: production,
    path: "/",
  };
}

export async function startSession(
  req: Request,
  userId: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    // void promises because we dont really care about the return type
    req.session.regenerate((error: unknown) => {
      if (error) reject(new AuthStorageError("Could not create a session."));
      else resolve();
    });
  });

  req.session.userId = userId;

  await new Promise<void>((resolve, reject) => {
    req.session.save((error: unknown) => {
      if (error) reject(new AuthStorageError("Could not save the session."));
      else resolve();
    });
  });
}

export async function endSession(req: Request): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.destroy((error: unknown) => {
      if (error) reject(new AuthStorageError("Could not end the session."));
      else resolve();
    });
  });
}
