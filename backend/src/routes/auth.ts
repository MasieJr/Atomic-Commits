import { Router } from 'express';

import type { AuthController } from '../controllers/auth';
import { createRequireLogin } from '../middleware/require-login';
import type { AccessTokenService } from '../services/tokens';

export function createAuthRouter(
  controller: AuthController,
  tokens: AccessTokenService,
): Router {
  const router = Router();

  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.get('/me', createRequireLogin(tokens), controller.me);
  /* logout is stateless, it needs no valid token */
  router.post('/logout', controller.logout);

  return router;
}
