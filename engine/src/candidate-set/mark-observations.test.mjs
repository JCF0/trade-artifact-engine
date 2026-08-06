#!/usr/bin/env node
import assert from 'node:assert/strict';
import { buildMarkObservationV1, canonicalizeMarkObservationsV1, validateMarkObservationsV1 } from './mark-observations.mjs';
import { providerPublicKey } from '../wallet-acquisition/fixtures/test-identities.mjs';

const TOKEN = providerPublicKey('TOKEN'); const ZZZ = providerPublicKey('ZZZ'); const QUOTE = providerPublicKey('QUOTE');
const available = buildMarkObservationV1({ token_mint: TOKEN, quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 2.5, observed_at: 100, source_slot: 10, reason_code: null });
const unavailable = buildMarkObservationV1({ token_mint: ZZZ, quote_mint: QUOTE, observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_source_unavailable' });
assert.equal(available.mark_observation_id, `amo1_${available.mark_observation_digest}`);
const canonical = canonicalizeMarkObservationsV1([unavailable, available], { markProfile: 'direct_quote_mark_v1' });
assert.deepEqual(canonical.map(item => item.token_mint), [TOKEN, ZZZ].sort());
assert.ok(Object.isFrozen(canonical) && Object.isFrozen(canonical[0]));
assert.doesNotThrow(() => validateMarkObservationsV1(canonical, { markProfile: 'direct_quote_mark_v1', anchorSlot: 10, anchorBlockTime: 100 }));
const laterEvidence = buildMarkObservationV1({ token_mint: TOKEN, quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 2.5, observed_at: 110, source_slot: 11, reason_code: null });
assert.doesNotThrow(() => validateMarkObservationsV1([laterEvidence], { markProfile: 'direct_quote_mark_v1', anchorSlot: 10, anchorBlockTime: 100 }));
assert.throws(() => buildMarkObservationV1({ token_mint: TOKEN, quote_mint: QUOTE, observation_status: 'available', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: 0, observed_at: 100, source_slot: 10, reason_code: null }), error => error.code === 'invalid_field');
assert.throws(() => buildMarkObservationV1({ token_mint: TOKEN, quote_mint: QUOTE, observation_status: 'unavailable', source_profile: 'direct_quote_mark_v1', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'invented_reason' }), error => error.code === 'mark_observation_invalid');
assert.throws(() => buildMarkObservationV1({ token_mint: TOKEN, quote_mint: QUOTE, observation_status: 'unavailable', source_profile: 'invented_profile', mark_price_raw_quote: null, observed_at: null, source_slot: null, reason_code: 'mark_source_unavailable' }), error => error.code === 'unsupported_profile');
assert.throws(() => validateMarkObservationsV1([available], { markProfile: 'other_profile', anchorSlot: 10, anchorBlockTime: 100 }), error => error.code === 'mark_observation_invalid');
assert.throws(() => canonicalizeMarkObservationsV1([available, available], { markProfile: 'direct_quote_mark_v1' }), error => error.code === 'duplicate_mark_observation');
assert.throws(() => canonicalizeMarkObservationsV1([available, laterEvidence], { markProfile: 'direct_quote_mark_v1' }), error => error.code === 'duplicate_mark_observation');
console.log('candidate-set mark observations: PASS');
