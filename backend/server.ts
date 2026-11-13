import 'dotenv/config';

import { createApp } from './src/app';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const { app, authConfigured, close, reconcilePayments, reconcileRevocations } = createApp({
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY,
  dataEncryptionKeyVersion: process.env.DATA_ENCRYPTION_KEY_VERSION,
  dataEncryptionKeyV1: process.env.DATA_ENCRYPTION_KEY_V1,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  webAllowedOrigins: (process.env.WEB_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  trustProxyLoopback: process.env.TRUST_PROXY_LOOPBACK === '1',
  allowedDriftSteps: process.env.TOTP_ALLOWED_DRIFT_STEPS === '0' ? 0 : 1,
});

if (require.main === module) {
  const onListening = () => {
    console.log(`Backend listening on port ${port}`);
    if (!authConfigured) {
      console.log('Auth is unavailable: set DATABASE_URL and a JWT_SECRET of at least 32 characters.');
    }
  };
  const server = process.env.HOST ? app.listen(port, process.env.HOST, onListening) : app.listen(port, onListening);

  /* crash recovery: settle payments left unresolved by a previous run, then keep checking.
     read-only towards the provider; it never re-submits a payment. Revoked grants whose
     provider cancellation is still open are retried after the payments pass */
  const reconcile = () => {
    void Promise.resolve(reconcilePayments())
      .then((result) => {
        if (result && result.checked > 0) console.log(`Reconciled ${result.checked} unresolved payment(s).`);
      })
      .catch(() => console.error('Payment reconciliation pass failed; will retry.'))
      .then(() => reconcileRevocations())
      .then((result) => {
        if (result && result.checked > 0) console.log(`Retried provider cancellation for ${result.checked} revoked grant(s).`);
      })
      .catch(() => console.error('Grant revocation pass failed; will retry.'));
  };
  reconcile();
  const reconcileTimer = setInterval(reconcile, 60_000);
  reconcileTimer.unref();

  const shutdown = () => {
    clearInterval(reconcileTimer);
    server.close(() => {
      void close().catch(() => { process.exitCode = 1; });
    });
    /* idle keep-alive sockets (e.g. an open docs tab) would otherwise hold close() open forever */
    server.closeIdleConnections();
    /* backstop: a redemption can wait up to 15 s for provider confirmation, so give in-flight requests 25 s */
    setTimeout(() => process.exit(), 25_000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export = app;
