import { assertExactFields, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { buildOrcaMessageBoundaryV1, assertExactOrcaMessageV1 } from './orca-message-boundary-v1.mjs';
import { retainExactSignedWireV1 } from './orca-signed-wire-boundary-v1.mjs';
import { createWigglesAuthenticatedControlPlaneV1 } from './wiggles-authenticated-control-plane-v1.mjs';

const SOURCE_FIELDS = ['blockhash', 'tick_spacing', 'tick_current_index', 'quoted_output_raw',
  'minimum_output_raw', 'fee_lamports', 'fee_message_sha256'];
function reject(message) { fail('bounded_agent_orca_composition_blocked', message); }

// Offline-testable future adapter, NOT the live factory. Source capture and signer
// capabilities are trusted executor wiring, not channel arguments. No RPC, key loader,
// operational wallet, submission callback, or scheduler is constructed here.
export function createOfflineOrcaSigningCompositionV1({
  mandate, authorization, executor_release_sha256, state_root, durable_episode_authority,
  acquisition_closure_port, readiness_challenge_port, build_input_port, message_signer_port,
}) {
  const frozenMandate = cloneAndFreeze(mandate);
  const capture = build_input_port.captureBuildInputV1.bind(build_input_port);
  const sign = message_signer_port.signExactMessageV1.bind(message_signer_port);
  const inspect = durable_episode_authority.inspectEpisodeV1.bind(durable_episode_authority);
  const loadState = durable_episode_authority.loadCurrentEpisodeStateV1.bind(durable_episode_authority);
  const pending = new Map();
  return createWigglesAuthenticatedControlPlaneV1({
    mandate: frozenMandate, authorization: cloneAndFreeze(authorization), executor_release_sha256,
    durable_episode_authority, acquisition_closure_port, readiness_challenge_port,
    execution_port: {
      async prepareBoundedLegV1({ challenge, admission }) {
        const state = await loadState({ episode_id: admission.episode_id });
        const acquisition = admission.phase === 'ACQUISITION';
        if (!acquisition && (state.chain_derived_acquired_jup_raw !== admission.chain_derived_disposal_jup_raw
            || state.acquisition_evidence_digest !== challenge.finalized_acquisition_evidence_digest)) {
          reject('disposal quantity/evidence does not match reopened authority');
        }
        const source = cloneAndFreeze(await capture({ challenge, admission }));
        assertExactFields(source, SOURCE_FIELDS, 'executor_orca_build_input');
        if (sha256CanonicalJson({ episode_id: admission.episode_id, ordinal: admission.ordinal, source })
            !== challenge.readiness_evidence_digest) reject('build input does not bind issued readiness');
        const { fee_message_sha256, ...fields } = source;
        const plan = buildOrcaMessageBoundaryV1({ ...fields, mandate: frozenMandate,
          phase: admission.phase, ordinal: admission.ordinal,
          input_raw_quantity: acquisition ? frozenMandate.economic_authority.acquisition_input_usdc_raw
            : state.chain_derived_acquired_jup_raw,
          retained_acquisition_jup_raw: acquisition ? null : state.chain_derived_acquired_jup_raw,
        });
        if (fee_message_sha256 !== plan.message_sha256) reject('fee does not bind exact serialized message');
        const prepared = cloneAndFreeze({
          prepared_transaction_version: 'artifact_bounded_agent_prepared_transaction_v1',
          episode_id: admission.episode_id, phase: admission.phase, admission_digest: admission.admission_digest,
          wallet: frozenMandate.wallet_scope.wallet, pool: frozenMandate.route_scope.pool,
          input_mint: plan.input_mint, output_mint: plan.output_mint, input_raw_quantity: plan.input_raw_quantity,
          maximum_slippage_bps: frozenMandate.economic_authority.maximum_slippage_bps,
          transaction_profile: 'DIRECT_CLASSIC_ORCA_LEGACY_SWAP_V1',
          unsigned_transaction_digest: sha256CanonicalJson(plan), readiness_evidence_digest: challenge.readiness_evidence_digest,
        });
        if (pending.has(admission.admission_digest)) reject('prepared plan already exists');
        pending.set(admission.admission_digest, { plan, prepared, challenge });
        return prepared;
      },
    },
    wallet_signer_port: {
      async signAdmittedTransactionV1({ admission, prepared_transaction }) {
        const retained = pending.get(admission.admission_digest);
        pending.delete(admission.admission_digest); // Consume even if inspection or signing fails.
        if (!retained || sha256CanonicalJson(retained.prepared) !== sha256CanonicalJson(prepared_transaction)) {
          reject('no exact private prepared plan');
        }
        const current = await inspect({ episode_id: admission.episode_id });
        const row = current.ordinals.find(item => item.ordinal === admission.ordinal);
        if (current.revoked || row?.stage !== 'KEY_LOAD_STARTED_AMBIGUOUS'
            || row.admission_digest !== admission.admission_digest
            || row.prepared_transaction_digest !== sha256CanonicalJson(retained.prepared)
            || row.semantic_transaction_digest !== retained.prepared.unsigned_transaction_digest) {
          reject('durable signing checkpoint mismatch');
        }
        const message = Buffer.from(retained.plan.message_base64, 'base64');
        assertExactOrcaMessageV1(retained.plan, message);
        if (typeof build_input_port.assertFreshBeforeSigningV1 === 'function') {
          await build_input_port.assertFreshBeforeSigningV1({ challenge: retained.challenge });
        }
        const result = await sign(Buffer.from(message));
        if (!Buffer.isBuffer(result)) reject('signer must return exact wire bytes');
        const wire = Buffer.from(result);
        const identity = retainExactSignedWireV1({ root: state_root, ordinal: admission.ordinal, message, wire });
        return { signed_wire_path: identity.signed_wire_path, signed_transaction_intent: {
          signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1',
          episode_id: admission.episode_id, phase: admission.phase, admission_digest: admission.admission_digest,
          semantic_transaction_digest: retained.prepared.unsigned_transaction_digest,
          message_sha256: identity.message_sha256, signed_wire_sha256: identity.signed_wire_sha256,
          signature: identity.signature, sign_count: 1,
        } };
        // The enclosing authenticated control plane reopens/verifies these bytes and
        // commits SIGNED_INTENT_DURABLE before returning the intent. No wire is exposed.
      },
    },
  });
}
