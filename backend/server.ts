import 'dotenv/config';

import { createApp } from './src/app';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const { app, authConfigured, close, reconcilePayments } = createApp({
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  dataEncryptionKey: process.env.DATA_ENCRYPTION_KEY,
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
    if (!authConfigured) {
      console.log('Auth is unavailable: set DATABASE_URL and a JWT_SECRET of at least 32 characters.');
    }
  });

  /* crash recovery: settle payments left unresolved by a previous run, then keep checking.
     read-only towards the provider; it never re-submits a payment */
  const reconcile = () => {
    void Promise.resolve(reconcilePayments())
      .then((result) => {
        if (result && result.checked > 0) console.log(`Reconciled ${result.checked} unresolved payment(s).`);
      })
      .catch(() => console.error('Payment reconciliation pass failed; will retry.'));
  };
  reconcile();
  const reconcileTimer = setInterval(reconcile, 60_000);
  reconcileTimer.unref();

  const shutdown = () => {
    clearInterval(reconcileTimer);
    server.close(() => {
      void close().catch(() => { process.exitCode = 1; });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export = app;
