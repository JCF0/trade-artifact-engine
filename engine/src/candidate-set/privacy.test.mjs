#!/usr/bin/env node
import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCandidateSelectionV1 } from './selection-resolver.mjs';
import { canonicalJson } from './serialize.mjs';
import {
  FIXTURE_MATRIX,
  buildDeterministicCandidateFixtureV1,
} from './fixtures/deterministic-fixtures.mjs';

const forbiddenIdentityKeys = [
  /^(?:raw_)?provider_(?:response|body|url)$/i,
  /^(?:request_)?headers?$/i,
  /^(?:api_?key|credential|secret|password|authorization)$/i,
  /^(?:retry|timeout)_(?:history|attempts?|events?)$/i,
  /^(?:hostname|host_name|process_?id|pid)$/i,
  /^(?:git|commit|branch|tag)_(?:metadata|sha|hash|name|id)$/i,
  /^(?:file|filesystem)_(?:path|root|location)$/i,
  /^(?:job|storage|upload|signing|mint|publication)_(?:id|identifier|handle|state|status)$/i,
  /^(?:cause|raw_cause|exception|stack|stack_trace)$/i,
];

const forbiddenSensitiveValue = [
  /\bhttps?:\/\//i,
  /\b(?:api[_-]?key|authorization|bearer|credential|password|secret)\b/i,
  /(?:^|[\s=:[(])\/(?:home|root|Users|private|tmp|var)\//,
  /(?:^|[\s=:[(])[A-Za-z]:\\/,
  /(?:^|[\s=:[(])\\\\[^\\]+\\[^\\]+/,
];

function walk(value, visit, path = []) {
  visit(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, [...path, index]));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) walk(item, visit, [...path, key]);
  }
}

function assertNoPrivateOperationalData(value) {
  walk(value, (item, path) => {
    const key = typeof path.at(-1) === 'string' ? path.at(-1) : '';
    assert.equal(forbiddenIdentityKeys.some(pattern => pattern.test(key)), false, `forbidden key at ${path.join('.')}`);
    if (typeof item === 'string') {
      assert.equal(forbiddenSensitiveValue.some(pattern => pattern.test(item)), false, `forbidden value at ${path.join('.')}`);
    }
  });
}

function allKeys(value) {
  const keys = [];
  walk(value, (_item, path) => {
    if (typeof path.at(-1) === 'string') keys.push(path.at(-1));
  });
  return keys;
}

function candidateFor(built, tokenMint) {
  const candidate = built.candidateSet.payload.candidates.find(item => item.projection.token_mint === tokenMint);
  assert.ok(candidate);
  return candidate;
}

test('evidence bundles and candidate sets exclude provider, secret, runtime, storage, and publication state', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.localizedAmbiguous);
  assertNoPrivateOperationalData(built.evidenceBundle);
  assertNoPrivateOperationalData(built.candidateSet);
  for (const finding of built.evidenceBundle.payload.activity_findings) {
    assert.deepEqual(
      Object.keys(finding).filter(key => /(?:message|description|title|prose|text|cause|detail)/i.test(key)),
      [],
    );
    assert.ok(finding.reason_codes.every(code => /^[a-z0-9_]+$/.test(code)));
    assert.ok(finding.disclosure_codes.every(code => /^[a-z0-9_]+$/.test(code)));
  }
});

test('identity-bearing source fields reject provider URLs, credentials, paths, and disclosure prose', () => {
  for (const source of [
    'https://provider.invalid/v1?authorization=Bearer-secret',
    '/root/private/provider-response.json',
    'Provider response failed after 3 retries',
    'Bearer-secret',
    'api_key',
    'authorization',
  ]) {
    const spec = structuredClone(FIXTURE_MATRIX.multipleCleanClosed);
    spec.events[0].source = source;
    assert.throws(() => buildDeterministicCandidateFixtureV1(spec), error => error.code === 'invalid_field');
  }
});

test('browser-facing candidate-set projection contains no replay evidence or private handles', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.multipleCleanClosed);
  const keys = allKeys(built.candidateSet);
  for (const forbidden of [
    'normalizedEvents', 'normalized_event_records', 'transaction_bodies', 'transactions',
    'projection_mapping', 'source_provider_body', 'provider_body', 'private_storage_handle',
    'package_store', 'upload_state', 'signing_state', 'mint_state', 'publication_state',
  ]) {
    assert.equal(keys.includes(forbidden), false, `browser candidate set contains ${forbidden}`);
  }
  const serialized = canonicalJson(built.candidateSet);
  for (const record of built.evidenceBundle.payload.normalized_event_records) {
    assert.equal(serialized.includes(record.slice7_event.tx_hash), false);
  }
});

test('resolver keeps the exact Slice 7 request and private audit mapping as separate structures', () => {
  const built = buildDeterministicCandidateFixtureV1(FIXTURE_MATRIX.multipleCleanClosed);
  const candidate = candidateFor(built, 'TOKEN-A');
  const input = {
    candidateSet: built.candidateSet,
    evidenceBundle: built.evidenceBundle,
    selection: {
      candidate_set_digest: built.candidateSet.candidate_set_digest,
      candidate_digest: candidate.candidate_digest,
    },
  };
  const result = resolveCandidateSelectionV1(input);
  assert.deepEqual(Object.keys(result), ['resolution_version', 'slice7_request', 'audit']);
  assert.deepEqual(Object.keys(result.slice7_request), ['normalizedEvents', 'inputStatus', 'target', 'profiles', 'mode']);
  assert.deepEqual(Object.keys(result.audit), [
    'candidate_set_digest', 'evidence_bundle_digest', 'candidate_digest',
    'receipt_scoped_evidence_digest', 'ledger_candidate_hash', 'projection_mapping',
  ]);
  assert.equal(Object.hasOwn(result.slice7_request, 'audit'), false);
  assert.equal(Object.hasOwn(result.audit, 'slice7_request'), false);
  const requestBytes = canonicalJson(result.slice7_request);
  for (const field of ['candidate_set_digest', 'evidence_bundle_digest', 'candidate_digest', 'receipt_scoped_evidence_digest', 'ledger_candidate_hash', 'projection_mapping']) {
    assert.equal(requestBytes.includes(field), false);
  }
  for (const area of [result.slice7_request.normalizedEvents, result.slice7_request.target, result.slice7_request.inputStatus, result.slice7_request.profiles, result.slice7_request.mode]) {
    const keys = allKeys(area);
    assert.equal(keys.some(key => /(?:candidate|evidence|projection)_.*(?:digest|mapping)|ledger_candidate_hash/.test(key)), false);
  }

  const before = canonicalJson(result);
  input.selection.candidate_digest = '0'.repeat(64);
  input.candidateSet = null;
  input.evidenceBundle = null;
  assert.equal(canonicalJson(result), before);
  assert.throws(() => { result.audit.projection_mapping.entries[0].projected_raw_index = 99; }, TypeError);
});
