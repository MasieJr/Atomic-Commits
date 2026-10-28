import type { RequestHandler } from 'express';

import type { AccessTokenService } from '../services/tokens';

declare module 'express-serve-static-core' {
  interface Request {
    /* set by requireLogin after a verified bearer token */
    userId?: number;
  }
}

/* bearer token check - replaces the old requireLogin cookie session guard */
export function createRequireLogin(tokens: AccessTokenService): RequestHandler {
  const requireLogin: RequestHandler = (req, res, next) => {
    const header = req.get('authorization');
    const token = /^Bearer ([A-Za-z0-9\-_.]+)$/i.exec(header ?? '')?.[1];
    const userId = token ? tokens.verify(token) : undefined;

    if (!Number.isSafeInteger(userId) || (userId ?? 0) < 1) {
      res.status(401).json({ error: 'Please log in first' });
      return;
    }

    req.userId = userId;
    next();
  };

  return requireLogin;
}
