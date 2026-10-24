import type { RequestHandler } from 'express';

export const requireLogin: RequestHandler = (req, res, next) => {
  if (!Number.isSafeInteger(req.session.userId) || (req.session.userId ?? 0) < 1) {
    res.status(401).json({ error: 'Please log in first' });
    return;
  }

  next();
};
