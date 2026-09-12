import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveredRuntimeFixtureV2 } from './fixtures/recovered-runtime-offline-v2.mjs';
import * as control from './retained-final-control-v1.mjs';
import { validateWigglesRuntimeConfigurationV1 } from './wiggles-trusted-runtime-v1.mjs';

test('V2 runtime deadline cannot outlive the enrolled custody grant', () => {
  const f = recoveredRuntimeFixtureV2();
  try {
    const c = structuredClone(f.configuration);
    c.deadline_unix_seconds = c.setup_provenance.enrollment.payload.not_after_unix_seconds + 1;
    assert.throws(() => validateWigglesRuntimeConfigurationV1(c, f.source.clock.unixSeconds()), /custody enrollment/);
  } finally { f.cleanup(); }
});

test('historical dispatch replay rejects originally expired custody but never consults current time', () => {
  assert.equal(typeof control.validateRetainedRecoveredSetupTimesV2, 'function');
  const f = recoveredRuntimeFixtureV2({ enrollment_not_after: 1900000100 });
  try {
    const input = { mandate: f.mandate, authorization: f.authorization, evidence: f.configuration.setup_provenance,
      dispatch_times: [1900000001, 1900000100] };
    assert.equal(control.validateRetainedRecoveredSetupTimesV2(input), true);
    assert.throws(() => control.validateRetainedRecoveredSetupTimesV2({ ...input, dispatch_times: [1900000101] }));
    assert.throws(() => control.validateRetainedRecoveredSetupTimesV2({ ...input, dispatch_times: [1899999999] }));
    assert.throws(() => control.validateRetainedRecoveredSetupTimesV2({ ...input, dispatch_times: [NaN] }));
  } finally { f.cleanup(); }
});
test('replay runtime boundary is exclusive even while enrollment remains valid', () => {
  const f = recoveredRuntimeFixtureV2();
  try {
    const input = { mandate: f.mandate, authorization: f.authorization, evidence: f.configuration.setup_provenance,
      runtime_deadline_unix_seconds: f.authorization.issued_at_unix_seconds + 1 };
    assert.equal(control.validateRetainedRecoveredSetupTimesV2({ ...input, dispatch_times: [f.authorization.issued_at_unix_seconds] }), true);
    assert.throws(() => control.validateRetainedRecoveredSetupTimesV2({ ...input, dispatch_times: [input.runtime_deadline_unix_seconds] }),
      /RECOVERED_RUNTIME_NOT_VALID_AT_ORIGINAL_DISPATCH/);
  } finally { f.cleanup(); }
});
