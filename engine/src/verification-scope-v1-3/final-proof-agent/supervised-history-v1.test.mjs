import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainedFinalEpisodeFixtureV1 } from './fixtures/retained-final-episode-v1.mjs';
import { reconstructFinalEpisodeReleaseV1 } from './final-episode-release-v1.mjs';
import { encodeBase58 } from './reused/bounded-rebroadcast-v1.mjs';
import { createHash } from 'node:crypto';

async function fixture() {
  const f = await retainedFinalEpisodeFixtureV1();
  const history = JSON.parse(f.files.get(f.descriptor.history.pages[0]));
  history.result.push({ signature: encodeBase58(Buffer.alloc(64, 4)), slot: 1,
    blockTime: f.control.mandate.setup_authority.latest_setup_block_time,
    err: null, memo: null, confirmationStatus: 'finalized' });
  const original = Buffer.from(JSON.stringify(history));
  assert.equal(createHash('sha256').update(original).digest('hex'), '7f079f0fd63d1c68b0b78aa5403201503ead07f13ba8ffd7d351ddece59dae13');
  const put = (name, value) => { f.files.set(name, Buffer.from(JSON.stringify(value))); return name; };
  f.files.set('history.json', original);
  const floor = JSON.parse(f.files.get(f.descriptor.history.slot)).result;
  const addresses = [f.control.mandate.wallet_scope.wallet, f.control.mandate.wallet_scope.jup_ata, f.control.mandate.wallet_scope.usdc_ata];
  const lanes = addresses.map((address, i) => {
    const request = before => ({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address,
      { commitment: 'finalized', limit: 100, minContextSlot: floor, ...(before ? { before } : {}) }] });
    return { address, pages: [
      { request: put(`request-${i}-0.json`, request()), response: 'history.json' },
      { request: put(`request-${i}-1.json`, request(history.result.at(-1).signature)), response: put(`empty-${i}.json`, { jsonrpc: '2.0', id: 1, result: [] }) },
    ], repeated_head: { request: put(`head-${i}.json`, request()), response: 'history.json' } };
  });
  f.descriptor.version = 'artifact_final_episode_replay_v3';
  f.descriptor.history.admission = put('history-admission.json', { version: 'artifact_supervised_history_v1', lanes });
  f.descriptor.history.pages.push('empty-0.json');
  return { f, original };
}

test('v3 admits the original three-row history including an older setup sentinel without rewriting bytes', async () => {
  const { f, original } = await fixture();
  const root = mkdtempSync(join(tmpdir(), 'artifact-history-v3-'));
  try {
    const result = await reconstructFinalEpisodeReleaseV1(f.write(root));
    assert.equal(result.integrity.status, 'VERIFIED');
    assert.equal(result.control.status, 'AUTHENTICATED');
    assert.equal(result.history_admission.rows.length, 9);
    assert.equal(result.history_admission.rows.filter(r => r.classification === 'OUTSIDE_WINDOW_SETUP_HISTORY').length, 3);
    assert.deepEqual(f.files.get('history.json'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('v3 rejects rehashed missing bodies, exclusions, equality, unknown times and pagination contradictions', async t => {
  const { f: baseline } = await fixture();
  const change = (f, name, mutate) => { const v = JSON.parse(f.files.get(name)); mutate(v); f.files.set(name, Buffer.from(JSON.stringify(v))); };
  const cases = [
    ['missing required body', f => { f.descriptor.transactions.pop(); }],
    ['producer exclusions', f => change(f, 'history-admission.json', v => { v.exclusions = ['old']; })],
    ['boundary equality', f => change(f, 'history.json', v => { v.result[2].blockTime = JSON.parse(f.files.get('block.json')).result.blockTime - f.descriptor.acquisition_request.window.requested_lookback_seconds; })],
    ['null time', f => change(f, 'history.json', v => { v.result[2].blockTime = null; })],
    ['future time', f => change(f, 'history.json', v => { v.result[0].blockTime = 2000000000; })],
    ['missing exhaustion', f => { f.files.set('empty-0.json', f.files.get('history.json')); }],
    ['wrong cursor', f => change(f, 'request-0-1.json', v => { v.params[1].before = encodeBase58(Buffer.alloc(64, 5)); })],
    ['missing context floor', f => change(f, 'request-0-0.json', v => { delete v.params[1].minContextSlot; })],
    ['changed head', f => change(f, 'history-admission.json', v => { v.lanes[0].repeated_head.response = 'empty-0.json'; })],
    ['duplicate row', f => change(f, 'history.json', v => { v.result.splice(1, 0, v.result[0]); })],
    ['inconsistent body', f => change(f, f.descriptor.transactions[0].response, v => { v.result.blockTime++; })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = { ...baseline, descriptor: structuredClone(baseline.descriptor), files: new Map(baseline.files) };
    mutate(f);
    const root = mkdtempSync(join(tmpdir(), 'artifact-history-negative-'));
    try { await assert.rejects(reconstructFinalEpisodeReleaseV1(f.write(root))); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  await t.test('legitimate overlap and differing older address histories', async () => {
    const f = { ...baseline, descriptor: structuredClone(baseline.descriptor), files: new Map(baseline.files) };
    const page = JSON.parse(f.files.get('history.json'));
    page.result[2] = { ...page.result[2], signature: encodeBase58(Buffer.alloc(64, 6)), blockTime: page.result[2].blockTime - 1 };
    f.files.set('distinct-setup.json', Buffer.from(JSON.stringify(page)));
    change(f, 'history-admission.json', v => { v.lanes[1].pages[0].response = 'distinct-setup.json'; v.lanes[1].repeated_head.response = 'distinct-setup.json'; });
    change(f, 'request-1-1.json', v => { v.params[1].before = page.result[2].signature; });
    const root = mkdtempSync(join(tmpdir(), 'artifact-history-overlap-'));
    try { const result = await reconstructFinalEpisodeReleaseV1(f.write(root)); assert.equal(result.control.status, 'AUTHENTICATED'); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
