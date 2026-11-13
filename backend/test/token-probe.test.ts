import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { OpenPaymentsClientError, type AuthenticatedClient, type Grant } from '@interledger/open-payments';
import { cancelContinuations, probeLifecycle, type ProbeStep, type ProbeToken } from '../src/commands/token-probe';
import type { ProofRun } from '../src/services/payment-proof-run';

const OLD = 'private-old-token';
const NEW = 'private-new-token';
const OLD_MANAGE = 'https://auth.interledger-test.dev/rotate-old';
const NEW_MANAGE = 'https://auth.interledger-test.dev/rotate-new';
const CONTINUE = 'https://auth.interledger-test.dev/private-continuation';

function harness() {
  const secrets: string[] = [];
  const run = {
    report: { results: { tokenProbe: { steps: [] } } },
    rememberSecret(value: string) { secrets.push(value); },
  } as unknown as ProofRun;
  return { run, secrets };
}

const initial: ProbeToken = { label: 'outgoing', value: OLD, manage: OLD_MANAGE, advertisedExpiresIn: 600 };

test('probe records token lifetime and stops reuse after confirmed rotation', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  const { run } = harness();
  let rotations = 0;
  let revocations = 0;
  const client = { token: {
    rotate: async () => {
      rotations++;
      if (rotations === 1) return { access_token: { value: NEW, manage: NEW_MANAGE, expires_in: 350 } };
      throw new OpenPaymentsClientError('private error', { status: 401, code: 'invalid_rotation', description: 'private provider detail' });
    },
    revoke: async ({ accessToken }: { accessToken: string }) => { assert.equal(accessToken, NEW); revocations++; },
  } } as unknown as AuthenticatedClient;
  await probeLifecycle(run, client, [], initial);
  assert.equal(rotations, 3);
  assert.equal(revocations, 1);
  const steps = (run.report.results.tokenProbe as { steps: ProbeStep[] }).steps;
  assert.deepEqual(steps.map((s) => s.outcome), ['OBTAINED', 'ROTATED', 'REJECTED', 'REVOKED', 'REJECTED']);
  const expiry = output.map((line) => JSON.parse(line)).find((line) => line.event === 'token-probe-expiry-comparison');
  assert.equal(expiry.advertisedExpiresInAfterRotation, 350);
  assert.ok(!output.join('\n').includes('private'));
  assert.ok(!output.join('\n').includes(NEW_MANAGE));
});

test('ambiguous or unexpectedly accepted old-token rotation stops before revocation', async (t) => {
  t.mock.method(console, 'log', () => {});
  for (const mode of ['ambiguous', 'unexpected-success'] as const) {
    const { run } = harness();
    let rotations = 0;
    let revocations = 0;
    const client = { token: {
      rotate: async () => {
        rotations++;
        if (rotations === 1) return { access_token: { value: NEW, manage: NEW_MANAGE, expires_in: 350 } };
        if (mode === 'ambiguous') throw new OpenPaymentsClientError('private', { status: 500, description: 'private provider text' });
        return { access_token: { value: 'unexpected-token', manage: NEW_MANAGE, expires_in: 300 } };
      },
      revoke: async () => { revocations++; },
    } } as unknown as AuthenticatedClient;
    await probeLifecycle(run, client, [], initial);
    const steps = (run.report.results.tokenProbe as { steps: ProbeStep[] }).steps;
    assert.equal(rotations, 2);
    assert.equal(revocations, 0);
    assert.equal(steps[steps.length - 1].outcome, mode === 'ambiguous' ? 'INCONCLUSIVE' : 'ROTATED');
    assert.ok(!JSON.stringify(steps).includes('private'));
  }
});

test('grant cleanup never prints continuation URIs or provider error text', async (t) => {
  const output: string[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) => { output.push(args.join(' ')); });
  t.mock.method(console, 'error', (...args: unknown[]) => { output.push(args.join(' ')); });
  const { run, secrets } = harness();
  const grant = { continue: { uri: CONTINUE, access_token: { value: 'private-continuation-token' } } } as unknown as Grant;
  const client = { grant: { cancel: async () => { throw new Error('private provider description'); } } } as unknown as AuthenticatedClient;
  assert.equal(await cancelContinuations(run, client, [grant]), 1);
  assert.ok(secrets.includes(CONTINUE));
  assert.ok(secrets.includes('private-continuation-token'));
  assert.ok(!output.join('\n').includes('private'));
  assert.ok(!output.join('\n').includes(CONTINUE));
});

test('missing wallet configuration exits without leaving the proof lock behind', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'token-probe-config-'));
  try {
    const result = spawnSync('node', [resolve(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), resolve(process.cwd(), 'src', 'commands', 'token-probe.ts'), 'resource'], {
      cwd: workdir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', TEMP: process.env.TEMP ?? '', TMP: process.env.TMP ?? '' },
      timeout: 60_000,
    });
    assert.equal(result.status, 1);
    assert.equal(existsSync(join(workdir, '.env.payment-proofs', 'active.lock')), false);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
