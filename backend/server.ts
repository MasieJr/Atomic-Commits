import 'dotenv/config';

import { createApp } from './src/app';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port');
}

const { app, authConfigured, close } = createApp({
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
});

if (require.main === module) {
  const server = app.listen(port, () => {
    console.log(`Backend listening on port ${port}`);
    if (!authConfigured) {
      console.log('Auth is unavailable: set DATABASE_URL and a JWT_SECRET of at least 32 characters.');
    }
  });

  const shutdown = () => {
    server.close(() => {
      void close().catch(() => { process.exitCode = 1; });
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

export = app;
