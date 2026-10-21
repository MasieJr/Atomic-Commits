import { Router } from 'express';

import type { AuthController } from '../controllers/auth';
import { requireLogin } from '../middleware/require-login';

export function createAuthRouter(controller: AuthController): Router {
  const router = Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', requireLogin, controller.me);
  router.post('/logout', requireLogin, controller.logout);

  return router;
}
