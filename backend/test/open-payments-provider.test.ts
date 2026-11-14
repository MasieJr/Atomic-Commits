import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OpenPaymentsClientError, type AuthenticatedClient, type WalletAddress } from '@interledger/open-payments';

import { createOpenPaymentsRedemptionProvider } from '../src/services/open-payments-redemption-provider';
import { ProviderRejectedError, ProviderUnknownError } from '../src/services/redemption-provider';

/* the live adapter, driven by a fake SDK client: no network */

const T = 'https://ilp.interledger-test.dev';
const wallets: Record<string, WalletAddress> = {
  payer: { id: `${T}/payer`, assetCode: 'EUR', assetScale: 2, authServer: 'https://auth.interledger-test.dev', resourceServer: T, publicName: 'p' } as WalletAddress,
  shop: { id: `${T}/shop`, assetCode: 'EUR', assetScale: 2, authServer: 'https://auth.interledger-test.dev', resourceServer: T, publicName: 's' } as WalletAddress,
};
const network = () => new Error('fetch failed');
const refused = () => new OpenPaymentsClientError('refused', { description: 'refused', status: 403 });

function fakeClient(plan: { quoteFailures?: Error[]; incomingFailures?: Error[]; submitError?: Error }) {
  const calls = { incomingCreate: 0, quoteCreate: 0, incomingComplete: 0, outgoingCreate: 0, grantRequest: 0 };
  const client = {
    grant: {
      request: async () => {
        calls.grantRequest += 1;
        return { access_token: { value: 'res-token', manage: `${T}/m`, expires_in: 600, access: [] }, continue: { uri: `${T}/c`, access_token: { value: 'c' } } };
      },
    },
    incomingPayment: {
      create: async () => {
        calls.incomingCreate += 1;
        const failure = plan.incomingFailures?.shift();
        if (failure) throw failure;
        return { id: `${T}/incoming/1`, walletAddress: wallets.shop.id };
      },
      complete: async () => {
        calls.incomingComplete += 1;
        return {};
      },
    },
    quote: {
      create: async () => {
        calls.quoteCreate += 1;
        const failure = plan.quoteFailures?.shift();
        if (failure) throw failure;
        return {
          id: `${T}/quotes/1`, walletAddress: wallets.payer.id, receiver: `${T}/incoming/1`,
          debitAmount: { value: '110', assetCode: 'EUR', assetScale: 2 },
          receiveAmount: { value: '10', assetCode: 'EUR', assetScale: 2 },
        };
      },
    },
    outgoingPayment: {
      create: async () => {
        calls.outgoingCreate += 1;
        if (plan.submitError) throw plan.submitError;
        return { id: `${T}/outgoing/1` };
      },
    },
  };
  const provider = createOpenPaymentsRedemptionProvider(async () => client as unknown as AuthenticatedClient, {
    lookupWallets: async (addresses) => addresses.map((a) => (a.includes('shop') ? wallets.shop : wallets.payer)),
    retryDelayMs: 1,
  });
  return { provider, calls };
}

const quoteArgs = {
  payerWalletAddress: `${T}/payer`,
  merchantWalletAddress: `${T}/shop`,
  merchantReceive: { value: '10', assetCode: 'EUR', assetScale: 2 },
  reference: 'ref',
};

test('a network drop on the quote is retried once and the payment proceeds', async () => {
  const { provider, calls } = fakeClient({ quoteFailures: [network()] });
  const quote = await provider.prepareQuote(quoteArgs);
  assert.equal(quote.debit.value, '110');
  assert.equal(calls.quoteCreate, 2);
  assert.equal(calls.incomingCreate, 1);
  assert.equal(calls.incomingComplete, 0);
});

test('if the quote still fails, the merchant incoming payment is closed', async () => {
  const { provider, calls } = fakeClient({ quoteFailures: [network(), network()] });
  await assert.rejects(provider.prepareQuote(quoteArgs));
  assert.equal(calls.quoteCreate, 2);
  assert.equal(calls.incomingComplete, 1);
});

test('a definite refusal is not retried', async () => {
  const { provider, calls } = fakeClient({ quoteFailures: [refused()] });
  await assert.rejects(provider.prepareQuote(quoteArgs));
  assert.equal(calls.quoteCreate, 1);
  assert.equal(calls.incomingComplete, 1);
});

test('a network drop on the incoming payment is retried once', async () => {
  const { provider, calls } = fakeClient({ incomingFailures: [network()] });
  await provider.prepareQuote(quoteArgs);
  assert.equal(calls.incomingCreate, 2);
});

test('submitting a payment is NEVER retried: unclear = UNKNOWN, refusal = rejected', async () => {
  const authority = { accessToken: 'tok' };
  const unclear = fakeClient({ submitError: network() });
  await assert.rejects(
    unclear.provider.submitPayment({ payerWalletAddress: `${T}/payer`, quoteId: `${T}/quotes/1`, authority }),
    ProviderUnknownError,
  );
  assert.equal(unclear.calls.outgoingCreate, 1);

  const no = fakeClient({ submitError: refused() });
  await assert.rejects(
    no.provider.submitPayment({ payerWalletAddress: `${T}/payer`, quoteId: `${T}/quotes/1`, authority }),
    ProviderRejectedError,
  );
  assert.equal(no.calls.outgoingCreate, 1);
});

test('provider confirmation requires the exact recipient amount and matching payment references', async () => {
  const debit = { value: '110', assetCode: 'EUR', assetScale: 2 };
  const receive = { value: '10', assetCode: 'EUR', assetScale: 2 };
  const outgoing = {
    id: `${T}/outgoing/1`, walletAddress: wallets.payer.id, quoteId: `${T}/quotes/1`,
    receiver: `${T}/incoming/1`, debitAmount: debit, sentAmount: debit, failed: false,
  };
  const incoming = {
    id: `${T}/incoming/1`, walletAddress: wallets.shop.id, receivedAmount: receive, completed: true,
  };
  const client = {
    grant: { request: async () => ({
      access_token: { value: 'resource', manage: `${T}/m`, expires_in: 600, access: [] },
      continue: { uri: `${T}/c`, access_token: { value: 'c' } },
    }) },
    outgoingPayment: { get: async () => outgoing },
    incomingPayment: { get: async () => incoming },
  } as unknown as AuthenticatedClient;
  const provider = createOpenPaymentsRedemptionProvider(async () => client, {
    lookupWallets: async () => [wallets.shop], retryDelayMs: 1,
  });
  const args = {
    outgoingPaymentId: outgoing.id, incomingPaymentId: incoming.id, quoteId: outgoing.quoteId,
    payerWalletAddress: wallets.payer.id, merchantWalletAddress: wallets.shop.id,
    expectedDebit: debit, expectedReceive: receive, authority: { accessToken: 'token' },
  };

  assert.equal((await provider.readOutcome(args)).kind, 'SUCCEEDED');
  incoming.receivedAmount = { ...receive, value: '9' };
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
  incoming.receivedAmount = { ...receive, assetCode: 'USD' };
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
  incoming.receivedAmount = receive;
  outgoing.sentAmount = { ...debit, assetCode: 'USD' };
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
  outgoing.sentAmount = debit;
  outgoing.quoteId = `${T}/quotes/other`;
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
  outgoing.quoteId = args.quoteId;
  outgoing.failed = true;
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
  outgoing.sentAmount = { ...debit, value: '0' };
  incoming.receivedAmount = { ...receive, value: '0' };
  assert.equal((await provider.readOutcome(args)).kind, 'FAILED');
  incoming.receivedAmount = { ...receive, value: '1' };
  assert.equal((await provider.readOutcome(args)).kind, 'PENDING');
});

test('wallet lookup rejects non-Test-Wallet addresses before making a network request', async () => {
  let lookups = 0;
  const provider = createOpenPaymentsRedemptionProvider(undefined, {
    lookupWallets: async () => { lookups += 1; return [wallets.payer]; }, retryDelayMs: 1,
  });
  await assert.rejects(provider.lookupWallet('https://127.0.0.1/private'));
  assert.equal(lookups, 0);
});
