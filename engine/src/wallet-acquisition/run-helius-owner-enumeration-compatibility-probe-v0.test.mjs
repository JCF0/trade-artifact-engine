#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseHeliusOwnerEnumerationProbeArgsV0,
  runHeliusOwnerEnumerationProbeFromEnvironmentV0,
} from './run-helius-owner-enumeration-compatibility-probe-v0.mjs';
import {
  CLASSIC_TOKEN_PROGRAM_V0,
  TOKEN_2022_PROGRAM_V0,
} from './helius-owner-enumeration-compatibility-probe-v0.mjs';
import { providerPublicKey } from './fixtures/test-identities.mjs';

const KEY_CANARY = 'helius-secret-canary-never-retain';
const PROVIDER_PROSE_CANARY = 'arbitrary provider prose never retain';
const EMPTY_WALLET = providerPublicKey('runner-empty-wallet');
const KNOWN_WALLET = providerPublicKey('runner-known-wallet');
const CLASSIC_ACCOUNT = providerPublicKey('runner-classic-account');
const TOKEN_2022_ACCOUNT = providerPublicKey('runner-token2022-account');
function temp(t) {
  const root = mkdtempSync(join(tmpdir(), 'artifact-helius-owner-probe-v0-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function environment() {
  return {
    HELIUS_API_KEY: KEY_CANARY,
    HELIUS_PLAN_PROFILE: 'FREE',
    HELIUS_EMPTY_CONTROL_WALLET: EMPTY_WALLET,
    HELIUS_KNOWN_CONTROL_WALLET: KNOWN_WALLET,
    HELIUS_EXPECTED_CLASSIC_ACCOUNTS_JSON: JSON.stringify([CLASSIC_ACCOUNT]),
    HELIUS_EXPECTED_TOKEN_2022_ACCOUNTS_JSON: JSON.stringify([TOKEN_2022_ACCOUNT]),
  };
}
function row(pubkey, owner) {
  return { pubkey, account: {
    data: [Buffer.from(pubkey).toString('base64'), 'base64'], executable: false,
    lamports: 1, owner, rentEpoch: 0, space: 165,
  } };
}
function responseFor(body) {
  const [wallet, filter, config] = body.params;
  const account = filter.programId === CLASSIC_TOKEN_PROGRAM_V0 ? CLASSIC_ACCOUNT : TOKEN_2022_ACCOUNT;
  const rows = wallet === EMPTY_WALLET ? [] : [row(account, filter.programId)];
  if (config.minContextSlot !== undefined) return { jsonrpc: '2.0', id: body.id, error: { code: -32016 } };
  if (body.method === 'getTokenAccountsByOwner') {
    return { jsonrpc: '2.0', id: body.id, result: { context: { apiVersion: `${PROVIDER_PROSE_CANARY}; ${KEY_CANARY}`, slot: 55 }, value: rows } };
  }
  return { jsonrpc: '2.0', id: body.id, result: {
    context: { apiVersion: `${PROVIDER_PROSE_CANARY}; ${KEY_CANARY}`, slot: 55 }, value: { accounts: rows, paginationKey: null },
  } };
}

test('CLI requires an explicit live-authorization flag and one report path', () => {
  const path = '/tmp/artifact-helius-owner-probe-v0.json';
  assert.deepEqual(parseHeliusOwnerEnumerationProbeArgsV0([
    '--execute-authorized-live-probe', '--report-path', path,
  ]), { execute_authorized_live_probe: true, report_path: path });
  assert.throws(() => parseHeliusOwnerEnumerationProbeArgsV0(['--report-path', path]), error => error.code === 'invalid_probe_request');
  assert.throws(() => parseHeliusOwnerEnumerationProbeArgsV0([
    '--execute-authorized-live-probe', '--report-path', path, '--extra', 'x',
  ]), error => error.code === 'invalid_probe_request');
});

test('writes exactly one mode-0600 sanitized report and keeps the API key only in request URLs', t => {
  const root = temp(t);
  const reportPath = join(root, 'report.json');
  const seenUrls = [];
  return runHeliusOwnerEnumerationProbeFromEnvironmentV0(
    { execute_authorized_live_probe: true, report_path: reportPath },
    {
      environment: environment(),
      clock: (() => { let now = 0; return () => now; })(),
      sleep: async () => {},
      async fetch(url, init) {
        seenUrls.push(url);
        const data = responseFor(JSON.parse(init.body));
        return { status: 200, async text() { return JSON.stringify(data); } };
      },
    },
  ).then(result => {
    const bytes = readFileSync(reportPath, 'utf8');
    assert.equal(result.report.observed_compatibility.verdict, 'PASS');
    assert.equal(result.report.verdict, 'UNRESOLVED');
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    assert.equal(bytes.includes(KEY_CANARY), false);
    assert.equal(bytes.includes(PROVIDER_PROSE_CANARY), false);
    assert.equal(bytes.includes('api_version'), false);
    assert.equal(bytes.includes('api-key'), false);
    assert.equal(result.report.request_accounting.rpc_requests_made, 28);
    assert.equal(result.report.request_accounting.http_requests_made, 28);
    assert.equal(seenUrls.length, 28);
    assert.ok(seenUrls.every(url => url === `https://mainnet.helius-rpc.com/?api-key=${KEY_CANARY}`));
  });
});

test('rejects unavailable report paths before reading environment or making a request', async t => {
  const root = temp(t);
  const reportPath = join(root, 'report.json');
  writeFileSync(reportPath, 'canary', { mode: 0o640 });
  let environmentReads = 0;
  let fetchCalls = 0;
  await assert.rejects(runHeliusOwnerEnumerationProbeFromEnvironmentV0(
    { execute_authorized_live_probe: true, report_path: reportPath },
    {
      get environment() { environmentReads += 1; return environment(); },
      async fetch() { fetchCalls += 1; },
    },
  ), error => error.code === 'report_path_unavailable');
  assert.equal(environmentReads, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(readFileSync(reportPath, 'utf8'), 'canary');
});

test('source has no signing, minting, transfer, keypair, store, upload, or deployment capability', () => {
  const runnerSource = readFileSync(new URL('./run-helius-owner-enumeration-compatibility-probe-v0.mjs', import.meta.url), 'utf8');
  const coreSource = readFileSync(new URL('./helius-owner-enumeration-compatibility-probe-v0.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runnerSource, /@solana\/web3|@solana\/spl-token|Keypair|sendTransaction|signTransaction|mintTo|transferChecked|secretKey/i);
  assert.doesNotMatch(runnerSource, /(?:package|archive|economics).*store|upload|deploy/i);
  assert.doesNotMatch(`${runnerSource}\n${coreSource}`, /\bimport\s*\(/);
  const imports = source => [...source.matchAll(/^import(?:[\s\S]*?from\s*)?['"]([^'"]+)['"];?$/gm)].map(match => match[1]).sort();
  assert.deepEqual(imports(coreSource), [
    '../verification-scope-v1-3/contract.mjs', './solana-identities.mjs', 'node:crypto',
  ].sort());
  assert.deepEqual(imports(runnerSource), [
    '../verification-scope-v1-3/contract.mjs', './helius-owner-enumeration-compatibility-probe-v0.mjs',
    'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:perf_hooks', 'node:url',
  ].sort());
});
