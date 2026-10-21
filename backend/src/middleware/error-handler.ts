import type { ErrorRequestHandler } from 'express';

import { AuthStorageError } from '../errors/auth';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AuthStorageError) {
    res.status(503).json({ error: 'Authentication storage is unavailable. Please try again later.' });
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error) {
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Request body must be valid JSON.' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request body exceeds the 10 KB limit.' });
      return;
    }
  }

  console.error('An API request failed.');
  res.status(500).json({ error: 'A server error occurred. Please try again.' });
};
