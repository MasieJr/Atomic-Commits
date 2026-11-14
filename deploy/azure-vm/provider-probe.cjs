const { randomBytes } = require('node:crypto');
const root = '/opt/atomic-commits/app';
require(`${root}/node_modules/dotenv`).config({ path: '/etc/atomic-commits/backend.env' });
const { createOpenPaymentsRedemptionProvider } = require(`${root}/dist/src/services/open-payments-redemption-provider`);
const { createWalletVerificationProvider } = require(`${root}/dist/src/services/wallet-verification-provider`);

(async () => {
  const provider = createOpenPaymentsRedemptionProvider();
  const verifier = createWalletVerificationProvider();
  const wallet = await provider.lookupWallet(process.env.CLIENT_WALLET_ADDRESS_URL);
  const callback = `${process.env.PUBLIC_BASE_URL}/api/wallet/callback/00000000-0000-4000-8000-000000000000`;
  const started = await verifier.start(wallet, callback, randomBytes(32).toString('base64url'));
  console.log('SUBJECT_VERIFICATION_REQUEST=STARTED');
  await verifier.cancel(started.continuation);
  console.log('SUBJECT_VERIFICATION_REQUEST=CANCELLED');
})().catch((error) => {
  console.error('SUBJECT_VERIFICATION_REQUEST=FAILED', error?.name ?? 'Error', typeof error?.status === 'number' ? error.status : '');
  process.exitCode = 1;
});
