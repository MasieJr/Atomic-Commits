import { Router } from 'express';

import type { AuthController } from '../controllers/auth';
import { createRequireLogin } from '../middleware/require-login';
import type { AccessTokenService } from '../services/tokens';

export function createAuthRouter(
  controller: AuthController,
  tokens: AccessTokenService,
): Router {
  const router = Router();

  router.post('/email-code', controller.sendEmailCode);
  router.post('/register', controller.register);
  router.post('/login', controller.login);
  router.post('/refresh', controller.refresh);
  router.get('/me', createRequireLogin(tokens), controller.me);
  /* logout revokes the refresh token in the body; it needs no valid access token */
  router.post('/logout', controller.logout);

  return router;
}
