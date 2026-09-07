import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { assertExactFields, canonicalJson, cloneAndFreeze, fail, sha256CanonicalJson } from '../contract.mjs';
import { isAuthoritativeAcquisitionClosureProofV1 } from './acquisition-closure-authority-v1.mjs';
import {
  applyHumanRevocationV1,
  closeFinalizedLegV1,
  recordSignedIntentV1,
  validateBoundedAgentEpisodeStateV1,
} from './episode-state-machine-v1.mjs';
import { validateReadinessChallengeV1 } from './readiness-challenge-v1.mjs';
import { inspectSignedLegacyWire } from './reused/bounded-rebroadcast-v1.mjs';

const VERSION = 'artifact_bounded_agent_durable_decision_authority_v1';
const CLOSED_SCHEMA_SQL = `
      PRAGMA application_id = 1095914578;
      PRAGMA user_version = 3;
      CREATE TABLE authority_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        authority_version TEXT NOT NULL
      ) STRICT;
      CREATE TABLE episode_states (
        episode_id TEXT PRIMARY KEY,
        state_digest TEXT NOT NULL,
        state_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE readiness_challenges (
        challenge_id TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        predecessor_state_digest TEXT NOT NULL,
        challenge_json TEXT NOT NULL,
        FOREIGN KEY (episode_id) REFERENCES episode_states(episode_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id TEXT PRIMARY KEY,
        mandate_digest TEXT NOT NULL,
        authorization_digest TEXT NOT NULL,
        executor_release_sha256 TEXT NOT NULL,
        row_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ordinals (
        episode_id TEXT NOT NULL REFERENCES episodes(episode_id),
        ordinal INTEGER NOT NULL,
        phase TEXT NOT NULL,
        predecessor_state TEXT NOT NULL,
        predecessor_state_digest TEXT NOT NULL,
        decision_id TEXT NOT NULL UNIQUE,
        challenge_id TEXT NOT NULL UNIQUE,
        admission_digest TEXT NOT NULL,
        successor_state_digest TEXT NOT NULL,
        stage TEXT NOT NULL,
        prepared_transaction_digest TEXT,
        signed_intent_digest TEXT,
        semantic_transaction_digest TEXT,
        message_sha256 TEXT,
        transaction_signature TEXT,
        signed_wire_sha256 TEXT,
        signed_wire_path TEXT,
        finalized_evidence_digest TEXT,
        row_digest TEXT NOT NULL,
        PRIMARY KEY (episode_id, ordinal)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS revocations (
        episode_id TEXT PRIMARY KEY REFERENCES episodes(episode_id),
        predecessor_state TEXT NOT NULL,
        predecessor_state_digest TEXT NOT NULL,
        revoked_state_digest TEXT NOT NULL,
        revoked_at_unix_seconds INTEGER NOT NULL,
        authenticated_revocation_digest TEXT NOT NULL,
        row_digest TEXT NOT NULL
      ) STRICT;
      INSERT INTO authority_metadata VALUES (1, '${VERSION}');
    `;
const DB_NAME = 'bounded-agent-decision-authority-v1.sqlite';
const SOLANA_LEGACY_WIRE_MAX_BYTES = 1232;
const SQLITE_DATABASE_MAX_BYTES = 64 * 1024 * 1024;
const SQLITE_SHM_MAX_BYTES = 4 * 1024 * 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const EPISODE = /^bounded-agent-episode-[0-9a-f]{64}$/;
const DECISION = /^agent-decision-[0-9a-f]{64}$/;
const CHALLENGE = /^readiness-challenge-[0-9a-f]{64}$/;
const RESERVATION_FIELDS = [
  'episode_id', 'mandate_digest', 'authorization_digest', 'executor_release_sha256',
  'ordinal', 'phase', 'predecessor_state', 'predecessor_state_digest', 'decision_id', 'challenge_id',
  'admission_digest', 'successor_state',
];
const REVOCATION_FIELDS = [
  'episode_id', 'mandate_digest', 'authorization_digest', 'executor_release_sha256',
  'predecessor_state', 'predecessor_state_digest', 'revoked_state_digest',
  'revoked_at_unix_seconds', 'revocation_digest', 'successor_state',
];
const CHECKPOINT_FIELDS = ['episode_id', 'ordinal', 'admission_digest', 'prepared_transaction_digest'];
const PREPARED_FIELDS = [...CHECKPOINT_FIELDS, 'semantic_transaction_digest'];
const SIGNED_FIELDS = [...CHECKPOINT_FIELDS, 'signed_intent_digest', 'semantic_transaction_digest', 'message_sha256', 'transaction_signature', 'signed_wire_sha256', 'signed_wire_path'];
const SUBMISSION_FIELDS = ['episode_id', 'ordinal', 'signed_intent_digest', 'signed_wire_sha256'];
const FINALIZED_FIELDS = [...SUBMISSION_FIELDS, 'finalized_evidence_digest'];
const SIGNED_STATE_FIELDS = ['episode_id', 'ordinal', 'predecessor_state_digest', 'signed_intent_digest', 'successor_state'];

function durableError(message = 'durable executor state is missing, corrupt, conflicting, or unavailable') {
  fail('bounded_agent_durable_state_untrustworthy', message);
}
function requireDigest(value, context) {
  if (typeof value !== 'string' || !DIGEST.test(value)) durableError(`${context} is invalid`);
}
function validateEpisodeId(value) {
  if (typeof value !== 'string' || !EPISODE.test(value)) durableError('episode identity is invalid');
}
function validateEpisodeBinding(value) {
  if (typeof value.episode_id !== 'string' || !EPISODE.test(value.episode_id)) durableError('episode identity is invalid');
  for (const field of ['mandate_digest', 'authorization_digest', 'executor_release_sha256']) requireDigest(value[field], field);
}
function validateReservation(value) {
  assertExactFields(value, RESERVATION_FIELDS, 'durable_decision_reservation');
  validateEpisodeBinding(value);
  if (![1, 2].includes(value.ordinal)
      || value.phase !== (value.ordinal === 1 ? 'ACQUISITION' : 'DISPOSAL')
      || value.predecessor_state !== (value.ordinal === 1 ? 'AUTHORIZED_DORMANT' : 'ACQUISITION_EVIDENCE_CLOSED')
      || !DECISION.test(value.decision_id) || !CHALLENGE.test(value.challenge_id)) durableError('reservation identity is invalid');
  for (const field of ['predecessor_state_digest', 'admission_digest']) requireDigest(value[field], field);
  validateBoundedAgentEpisodeStateV1(value.successor_state);
}
function validateRevocation(value) {
  assertExactFields(value, REVOCATION_FIELDS, 'durable_authorization_revocation');
  validateEpisodeBinding(value);
  for (const field of ['predecessor_state_digest', 'revoked_state_digest', 'revocation_digest']) requireDigest(value[field], field);
  if (!['AUTHORIZED_DORMANT', 'ACQUISITION_ADMITTED', 'ACQUISITION_EVIDENCE_CLOSED',
    'DISPOSAL_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING', 'DISPOSAL_SUBMISSION_RESOLVING'].includes(value.predecessor_state)
      || !Number.isSafeInteger(value.revoked_at_unix_seconds) || value.revoked_at_unix_seconds < 0) durableError('revocation semantics are invalid');
  validateBoundedAgentEpisodeStateV1(value.successor_state);
}

function requireCommonStateIdentity(predecessor, successor) {
  if (successor.episode_id !== predecessor.episode_id
      || successor.mandate_digest !== predecessor.mandate_digest
      || successor.authorization_digest !== predecessor.authorization_digest) {
    fail('bounded_agent_durable_transition_invalid', 'episode state authority identity changed');
  }
}

function requireConsumedDecisionTransition(predecessor, successor, reservation) {
  requireCommonStateIdentity(predecessor, successor);
  const expectedStates = reservation.ordinal === 1
    ? ['ACQUISITION_ADMITTED', 'AGENT_REFUSED_ACQUISITION']
    : ['DISPOSAL_ADMITTED', 'AGENT_REFUSED_DISPOSAL'];
  if (!expectedStates.includes(successor.state)
      || successor.consumed_decision_ids.length !== predecessor.consumed_decision_ids.length + 1
      || successor.consumed_challenge_ids.length !== predecessor.consumed_challenge_ids.length + 1
      || canonicalJson(successor.consumed_decision_ids.slice(0, -1)) !== canonicalJson(predecessor.consumed_decision_ids)
      || canonicalJson(successor.consumed_challenge_ids.slice(0, -1)) !== canonicalJson(predecessor.consumed_challenge_ids)
      || successor.consumed_decision_ids.at(-1) !== reservation.decision_id
      || successor.consumed_challenge_ids.at(-1) !== reservation.challenge_id
      || successor.acquisition_evidence_digest !== predecessor.acquisition_evidence_digest
      || successor.chain_derived_acquired_jup_raw !== predecessor.chain_derived_acquired_jup_raw
      || successor.disposal_evidence_digest !== predecessor.disposal_evidence_digest) {
    fail('bounded_agent_durable_transition_invalid', 'decision successor is not the typed monotonic episode transition');
  }
}
function validateCheckpoint(value) {
  assertExactFields(value, CHECKPOINT_FIELDS, 'durable_execution_checkpoint');
  if (!EPISODE.test(value.episode_id) || ![1, 2].includes(value.ordinal)) durableError('checkpoint identity is invalid');
  requireDigest(value.admission_digest, 'admission_digest');
  requireDigest(value.prepared_transaction_digest, 'prepared_transaction_digest');
}
function episodeDigest(row) {
  return sha256CanonicalJson({
    authority_version: VERSION,
    episode_id: row.episode_id,
    mandate_digest: row.mandate_digest,
    authorization_digest: row.authorization_digest,
    executor_release_sha256: row.executor_release_sha256,
  });
}
function ordinalDigest(row) {
  return sha256CanonicalJson({
    authority_version: VERSION,
    episode_id: row.episode_id,
    ordinal: row.ordinal,
    phase: row.phase,
    predecessor_state: row.predecessor_state,
    predecessor_state_digest: row.predecessor_state_digest,
    decision_id: row.decision_id,
    challenge_id: row.challenge_id,
    admission_digest: row.admission_digest,
    successor_state_digest: row.successor_state_digest,
    stage: row.stage,
    prepared_transaction_digest: row.prepared_transaction_digest,
    signed_intent_digest: row.signed_intent_digest,
    semantic_transaction_digest: row.semantic_transaction_digest,
    message_sha256: row.message_sha256,
    transaction_signature: row.transaction_signature,
    signed_wire_sha256: row.signed_wire_sha256,
    signed_wire_path: row.signed_wire_path,
    finalized_evidence_digest: row.finalized_evidence_digest,
  });
}
function revocationDigest(row) {
  return sha256CanonicalJson({
    authority_version: VERSION,
    episode_id: row.episode_id,
    predecessor_state: row.predecessor_state,
    predecessor_state_digest: row.predecessor_state_digest,
    revoked_state_digest: row.revoked_state_digest,
    revoked_at_unix_seconds: row.revoked_at_unix_seconds,
    authenticated_revocation_digest: row.authenticated_revocation_digest,
  });
}
function verifyEpisodeRow(row) {
  if (row === undefined || row.row_digest !== episodeDigest(row)) durableError();
}
function verifyOrdinalRow(row) {
  if (row === undefined || row.row_digest !== ordinalDigest(row)) durableError();
}
function verifyRevocationRow(row) {
  if (row !== undefined && row.row_digest !== revocationDigest(row)) durableError();
}
function assertOrdinalStageShape(row) {
  const signedFields = ['signed_intent_digest', 'message_sha256', 'transaction_signature', 'signed_wire_sha256', 'signed_wire_path'];
  const expectsPrepared = row.stage !== 'RESERVED';
  const expectsSigned = ['SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE', 'FINALIZED'].includes(row.stage);
  const expectsFinalized = row.stage === 'FINALIZED';
  if (!['RESERVED', 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE', 'FINALIZED'].includes(row.stage)
      || (row.prepared_transaction_digest !== null) !== expectsPrepared
      || (row.semantic_transaction_digest !== null) !== expectsPrepared
      || signedFields.some(field => (row[field] !== null) !== expectsSigned)
      || (row.finalized_evidence_digest !== null) !== expectsFinalized) {
    durableError('ordinal checkpoint fields do not match its stage');
  }
}
function assertStateOrdinalStages(state, ordinals) {
  const stages = ordinals.map(row => row.stage);
  const oneOf = (actual, expected) => expected.includes(actual);
  const valid = {
    AUTHORIZED_DORMANT: () => stages.length === 0,
    ACQUISITION_ADMITTED: () => stages.length === 1 && oneOf(stages[0], ['RESERVED', 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE']),
    ACQUISITION_SUBMISSION_RESOLVING: () => stages.length === 1 && oneOf(stages[0], ['SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE']),
    ACQUISITION_EVIDENCE_CLOSED: () => stages.length === 1 && stages[0] === 'FINALIZED',
    AGENT_REFUSED_ACQUISITION: () => stages.length === 1 && stages[0] === 'RESERVED',
    DISPOSAL_ADMITTED: () => stages.length === 2 && stages[0] === 'FINALIZED' && oneOf(stages[1], ['RESERVED', 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE']),
    DISPOSAL_SUBMISSION_RESOLVING: () => stages.length === 2 && stages[0] === 'FINALIZED' && oneOf(stages[1], ['SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE']),
    DISPOSAL_EVIDENCE_CLOSED: () => stages.length === 2 && stages.every(stage => stage === 'FINALIZED'),
    AGENT_REFUSED_DISPOSAL: () => stages.length === 2 && stages[0] === 'FINALIZED' && stages[1] === 'RESERVED',
    REVOKED_BEFORE_FIRST_ADMISSION: () => stages.length === 0,
    REVOKED_BEFORE_ACQUISITION_SIGNING: () => stages.length === 1 && oneOf(stages[0], ['RESERVED', 'PREPARED']),
    REVOKED_BEFORE_DISPOSAL_SIGNING: () => stages.length === 2 && stages[0] === 'FINALIZED' && oneOf(stages[1], ['RESERVED', 'PREPARED']),
    REVOKED_AFTER_ACQUISITION: () => stages.length === 1 && stages[0] === 'FINALIZED',
    REVOKED_AFTER_DISPOSAL: () => stages.length === 2 && stages.every(stage => stage === 'FINALIZED'),
    RESOLUTION_REQUIRED_AFTER_REVOCATION: () => [1, 2].includes(stages.length)
      && (stages.length === 1 || stages[0] === 'FINALIZED')
      && oneOf(stages.at(-1), ['SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE']),
  }[state.state];
  if (valid === undefined || !valid()) durableError('episode state and ordinal stages are inconsistent');
  if (state.possible_submission && state.signed_intent_digest !== ordinals.at(-1)?.signed_intent_digest) {
    durableError('episode signed intent does not match its active durable ordinal');
  }
}
function bindingMatches(row, value) {
  return row.mandate_digest === value.mandate_digest
    && row.authorization_digest === value.authorization_digest
    && row.executor_release_sha256 === value.executor_release_sha256;
}

function assertOwnedPrivateBoundedFile(path, { effectiveUid, maximumBytes, allowMissing = false, allowEmpty = false }) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== effectiveUid || (stat.mode & 0o077) !== 0
      || (!allowEmpty && stat.size < 1) || stat.size > maximumBytes) {
    durableError('durable SQLite file ownership, mode, type, or size is untrustworthy');
  }
  return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

function assertSameFileIdentity(path, identity) {
  if (identity === null) return;
  const current = lstatSync(path);
  if (current.dev !== identity.dev || current.ino !== identity.ino) durableError('durable SQLite pathname identity changed during open');
}

function reconstructedEpisodeState(state, changes) {
  const value = { ...state, ...changes, state_id: `episode-state-${'0'.repeat(64)}`, state_digest: '0'.repeat(64) };
  const preimage = Object.fromEntries(Object.entries(value).filter(([field]) => !['state_id', 'state_digest'].includes(field)));
  value.state_digest = sha256CanonicalJson(preimage);
  value.state_id = `episode-state-${value.state_digest}`;
  validateBoundedAgentEpisodeStateV1(value);
  return value;
}
function assertOrdinalSuccessors(state, ordinals) {
  if (ordinals.length === 0) return;
  const authorized = reconstructedEpisodeState(state, {
    state: 'AUTHORIZED_DORMANT', next_ordinal: 1, possible_submission: false, human_revocation_status: 'NOT_REVOKED',
    consumed_decision_ids: [], consumed_challenge_ids: [], signed_intent_digest: null,
    acquisition_evidence_digest: null, chain_derived_acquired_jup_raw: null, disposal_evidence_digest: null,
  });
  const acquisitionRefused = state.state === 'AGENT_REFUSED_ACQUISITION';
  const acquisitionAdmitted = reconstructedEpisodeState(authorized, {
    state: acquisitionRefused ? 'AGENT_REFUSED_ACQUISITION' : 'ACQUISITION_ADMITTED',
    next_ordinal: acquisitionRefused ? null : 1, consumed_decision_ids: [ordinals[0].decision_id],
    consumed_challenge_ids: [ordinals[0].challenge_id],
  });
  if (ordinals[0].predecessor_state_digest !== authorized.state_digest
      || ordinals[0].successor_state_digest !== acquisitionAdmitted.state_digest) {
    durableError('acquisition ordinal does not bind its typed predecessor and successor');
  }
  if (ordinals.length === 1) return;
  const acquisitionClosed = reconstructedEpisodeState(state, {
    state: 'ACQUISITION_EVIDENCE_CLOSED', next_ordinal: 2, possible_submission: false,
    human_revocation_status: 'NOT_REVOKED', consumed_decision_ids: [ordinals[0].decision_id],
    consumed_challenge_ids: [ordinals[0].challenge_id], signed_intent_digest: null,
    disposal_evidence_digest: null,
  });
  const disposalRefused = state.state === 'AGENT_REFUSED_DISPOSAL';
  const disposalAdmitted = reconstructedEpisodeState(acquisitionClosed, {
    state: disposalRefused ? 'AGENT_REFUSED_DISPOSAL' : 'DISPOSAL_ADMITTED',
    next_ordinal: disposalRefused ? null : 2, consumed_decision_ids: ordinals.map(row => row.decision_id),
    consumed_challenge_ids: ordinals.map(row => row.challenge_id),
  });
  if (ordinals[1].predecessor_state_digest !== acquisitionClosed.state_digest
      || ordinals[1].successor_state_digest !== disposalAdmitted.state_digest) {
    durableError('disposal ordinal does not bind its typed predecessor and successor');
  }
}
function assertRevocationBindsState(state, ordinals, revocation) {
  const allowedPredecessors = {
    REVOKED_BEFORE_FIRST_ADMISSION: ['AUTHORIZED_DORMANT'],
    REVOKED_BEFORE_ACQUISITION_SIGNING: ['ACQUISITION_ADMITTED'],
    REVOKED_BEFORE_DISPOSAL_SIGNING: ['DISPOSAL_ADMITTED'],
    REVOKED_AFTER_ACQUISITION: ['ACQUISITION_ADMITTED', 'ACQUISITION_EVIDENCE_CLOSED', 'ACQUISITION_SUBMISSION_RESOLVING'],
    REVOKED_AFTER_DISPOSAL: ['DISPOSAL_ADMITTED', 'DISPOSAL_SUBMISSION_RESOLVING'],
    RESOLUTION_REQUIRED_AFTER_REVOCATION: ['ACQUISITION_ADMITTED', 'DISPOSAL_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING', 'DISPOSAL_SUBMISSION_RESOLVING'],
  }[state.state];
  if (allowedPredecessors === undefined || !allowedPredecessors.includes(revocation.predecessor_state)) durableError('revocation predecessor is incompatible with current state');
  const resolving = revocation.predecessor_state.endsWith('_SUBMISSION_RESOLVING');
  const predecessor = reconstructedEpisodeState(state, {
    state: revocation.predecessor_state,
    next_ordinal: ['AUTHORIZED_DORMANT', 'ACQUISITION_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING'].includes(revocation.predecessor_state) ? 1 : 2,
    possible_submission: resolving,
    human_revocation_status: 'NOT_REVOKED',
    signed_intent_digest: resolving ? ordinals.at(-1)?.signed_intent_digest : null,
    acquisition_evidence_digest: ['ACQUISITION_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING'].includes(revocation.predecessor_state) ? null : state.acquisition_evidence_digest,
    chain_derived_acquired_jup_raw: ['ACQUISITION_ADMITTED', 'ACQUISITION_SUBMISSION_RESOLVING'].includes(revocation.predecessor_state) ? null : state.chain_derived_acquired_jup_raw,
    disposal_evidence_digest: null,
  });
  if (predecessor.state_digest !== revocation.predecessor_state_digest) durableError('revocation predecessor digest is not reconstructable from retained episode evidence');
  const revoked = applyHumanRevocationV1({ state: predecessor, authorization_digest: state.authorization_digest });
  if (revoked.state_digest !== revocation.revoked_state_digest) durableError('revocation successor digest does not match its typed transition');
  let expectedCurrent = revoked;
  if (state.state === 'RESOLUTION_REQUIRED_AFTER_REVOCATION' && revoked.state !== state.state) {
    const signedPredecessor = recordSignedIntentV1({ state: predecessor, signed_intent_digest: ordinals.at(-1)?.signed_intent_digest });
    expectedCurrent = applyHumanRevocationV1({ state: signedPredecessor, authorization_digest: state.authorization_digest });
  }
  if (state.state === 'REVOKED_AFTER_ACQUISITION' && expectedCurrent.state !== 'REVOKED_AFTER_ACQUISITION') {
    if (expectedCurrent.state !== 'RESOLUTION_REQUIRED_AFTER_REVOCATION') {
      const signedPredecessor = recordSignedIntentV1({ state: predecessor, signed_intent_digest: ordinals.at(-1)?.signed_intent_digest });
      expectedCurrent = applyHumanRevocationV1({ state: signedPredecessor, authorization_digest: state.authorization_digest });
    }
    expectedCurrent = closeFinalizedLegV1({ state: expectedCurrent, phase: 'ACQUISITION', finalized_evidence_digest: state.acquisition_evidence_digest, chain_derived_acquired_jup_raw: state.chain_derived_acquired_jup_raw });
  } else if (state.state === 'REVOKED_AFTER_DISPOSAL') {
    if (expectedCurrent.state !== 'RESOLUTION_REQUIRED_AFTER_REVOCATION') {
      const signedPredecessor = recordSignedIntentV1({ state: predecessor, signed_intent_digest: ordinals.at(-1)?.signed_intent_digest });
      expectedCurrent = applyHumanRevocationV1({ state: signedPredecessor, authorization_digest: state.authorization_digest });
    }
    expectedCurrent = closeFinalizedLegV1({ state: expectedCurrent, phase: 'DISPOSAL', finalized_evidence_digest: state.disposal_evidence_digest, chain_derived_acquired_jup_raw: null });
  }
  if (expectedCurrent.state_digest !== state.state_digest) durableError('retained revocation does not lead to current typed episode state');
}
function readCanonicalShortvec(bytes, start) {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < bytes.length && offset < start + 3; offset += 1) {
    const octet = bytes[offset];
    value |= (octet & 0x7f) << shift;
    if ((octet & 0x80) === 0) {
      if ((offset > start && octet === 0) || value > 0xffff) durableError('legacy message shortvec is noncanonical');
      return { value, next: offset + 1 };
    }
    shift += 7;
  }
  durableError('legacy message shortvec is truncated or oversized');
}

function assertCanonicalLegacyMessage(message) {
  if (message.length < 3) durableError('legacy message header is truncated');
  const requiredSignatures = message[0];
  const readOnlySigned = message[1];
  const readOnlyUnsigned = message[2];
  let vector = readCanonicalShortvec(message, 3);
  const accountCount = vector.value;
  if (requiredSignatures !== 1 || accountCount < requiredSignatures
      || readOnlySigned > requiredSignatures || readOnlyUnsigned > accountCount - requiredSignatures) {
    durableError('legacy message header/account roles are inconsistent');
  }
  let offset = vector.next + accountCount * 32;
  if (offset + 32 > message.length) durableError('legacy message account keys or blockhash are truncated');
  offset += 32;
  vector = readCanonicalShortvec(message, offset);
  offset = vector.next;
  for (let instruction = 0; instruction < vector.value; instruction += 1) {
    if (offset >= message.length || message[offset] >= accountCount) durableError('legacy instruction program index is invalid');
    offset += 1;
    const accounts = readCanonicalShortvec(message, offset);
    offset = accounts.next;
    if (offset + accounts.value > message.length) durableError('legacy instruction account vector is truncated');
    for (let index = 0; index < accounts.value; index += 1) {
      if (message[offset + index] >= accountCount) durableError('legacy instruction account index is invalid');
    }
    offset += accounts.value;
    const data = readCanonicalShortvec(message, offset);
    offset = data.next;
    if (offset + data.value > message.length) durableError('legacy instruction data is truncated');
    offset += data.value;
  }
  if (offset !== message.length) durableError('legacy message has trailing bytes');
}

function readVerifiedSignedWire(root, value) {
  const signedWirePath = value.signed_wire_path;
  let wire;
  try {
    if (typeof signedWirePath !== 'string' || !isAbsolute(signedWirePath)
        || resolve(signedWirePath) !== signedWirePath || dirname(signedWirePath) !== root
        || realpathSync(signedWirePath) !== signedWirePath) durableError('signed wire path is untrusted');
    const descriptor = openSync(signedWirePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(descriptor);
      const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : stat.uid;
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== effectiveUid
          || stat.size < 1 || stat.size > SOLANA_LEGACY_WIRE_MAX_BYTES) {
        durableError('signed wire file must be an executor-owned private bounded regular file');
      }
      fsyncSync(descriptor);
      wire = readFileSync(descriptor);
    } finally { closeSync(descriptor); }
  } catch (error) {
    if (error?.name === 'VerificationScopeError') throw error;
    durableError('signed wire file is unavailable');
  }
  let rootDescriptor;
  try {
    rootDescriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(rootDescriptor);
  } catch { durableError('signed wire directory could not be made durable'); }
  finally { if (rootDescriptor !== undefined) closeSync(rootDescriptor); }
  if (createHash('sha256').update(wire).digest('hex') !== value.signed_wire_sha256) durableError('signed wire hash does not match durable bytes');
  let inspected;
  try { inspected = inspectSignedLegacyWire(wire.toString('base64')); assertCanonicalLegacyMessage(inspected.message); }
  catch { durableError('signed wire is not a canonical legacy Solana transaction'); }
  if (wire[0] !== 1 || inspected.message[0] !== 1 || (inspected.message[3] & 0x80) !== 0
      || inspected.message[3] < 1 || 4 + inspected.message[3] * 32 > inspected.message.length) {
    durableError('signed wire must contain one signer and a valid account-key vector');
  }
  const signatureBytes = wire.subarray(1, 65);
  const signerPublicKey = inspected.message.subarray(4, 36);
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), signerPublicKey]),
      format: 'der', type: 'spki',
    });
    signatureValid = verifySignature(null, inspected.message, publicKey, signatureBytes);
  } catch { signatureValid = false; }
  if (!signatureValid || inspected.expectedSignature !== value.transaction_signature
      || createHash('sha256').update(inspected.message).digest('hex') !== value.message_sha256) {
    durableError('signed wire identity does not match its message and signature');
  }
  return wire;
}

function openCrashDurableDecisionAuthorityV1({ state_root, initialize = false, provisioning = null }) {
  let database;
  let closed = false;
  let root;
  try {
    if (typeof state_root !== 'string' || !isAbsolute(state_root)) durableError('state_root must be an absolute pre-existing directory');
    root = realpathSync(state_root);
    if (root !== resolve(state_root)) durableError('state_root must not traverse symbolic links');
    const rootStat = lstatSync(root);
    const effectiveUid = typeof process.geteuid === 'function' ? process.geteuid() : rootStat.uid;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0 || rootStat.uid !== effectiveUid) durableError('state_root must be an executor-owned private directory with mode 0700');
    const databasePath = join(root, DB_NAME);
    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    const databaseIdentity = assertOwnedPrivateBoundedFile(databasePath, {
      effectiveUid, maximumBytes: SQLITE_DATABASE_MAX_BYTES, allowMissing: true,
    });
    const walIdentity = assertOwnedPrivateBoundedFile(walPath, {
      effectiveUid, maximumBytes: SQLITE_DATABASE_MAX_BYTES, allowMissing: true, allowEmpty: true,
    });
    const shmIdentity = assertOwnedPrivateBoundedFile(shmPath, {
      effectiveUid, maximumBytes: SQLITE_SHM_MAX_BYTES, allowMissing: true, allowEmpty: true,
    });
    const databaseExists = databaseIdentity !== null;
    if (!databaseExists && initialize !== true) durableError('durable state database is missing; implicit replacement is forbidden');
    if (databaseExists && initialize === true) durableError('durable state database already exists; reinitialization is forbidden');
    database = new DatabaseSync(databasePath, { timeout: 5000 });
    assertSameFileIdentity(databasePath, databaseIdentity);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    assertSameFileIdentity(databasePath, databaseIdentity);
    assertSameFileIdentity(walPath, walIdentity);
    assertSameFileIdentity(shmPath, shmIdentity);
    if (!databaseExists) database.exec(CLOSED_SCHEMA_SQL);
    database.exec('BEGIN');
    const applicationId = database.prepare('PRAGMA application_id').get();
    const userVersion = database.prepare('PRAGMA user_version').get();
    const metadata = database.prepare('SELECT singleton, authority_version FROM authority_metadata').get();
    if (applicationId?.application_id !== 1095914578 || userVersion?.user_version !== 3
        || metadata?.singleton !== 1 || metadata?.authority_version !== VERSION) durableError();
    const schemaRows = target => target.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
      .map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
    const expectedSchema = new DatabaseSync(':memory:');
    expectedSchema.exec(CLOSED_SCHEMA_SQL);
    const schemaMatches = canonicalJson(schemaRows(database)) === canonicalJson(schemaRows(expectedSchema));
    expectedSchema.close();
    if (!schemaMatches) durableError('durable SQLite schema is not the exact closed provisioned schema');
    chmodSync(databasePath, 0o600);
    for (const [path, maximumBytes] of [[databasePath, SQLITE_DATABASE_MAX_BYTES], [walPath, SQLITE_DATABASE_MAX_BYTES], [shmPath, SQLITE_SHM_MAX_BYTES]]) {
      try { chmodSync(path, 0o600); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      assertOwnedPrivateBoundedFile(path, { effectiveUid, maximumBytes, allowMissing: path !== databasePath, allowEmpty: path !== databasePath });
    }
    const integrity = database.prepare('PRAGMA integrity_check').get();
    if (integrity?.integrity_check !== 'ok') durableError();
    const verifiedStates = database.prepare('SELECT * FROM episode_states').all().map(row => {
      let state;
      try { state = JSON.parse(row.state_json); } catch { durableError(); }
      if (canonicalJson(state) !== row.state_json || row.state_digest !== state.state_digest) durableError();
      validateBoundedAgentEpisodeStateV1(state);
      return state;
    });
    const verifiedChallenges = database.prepare('SELECT * FROM readiness_challenges').all().map(row => {
      let challenge;
      try { challenge = JSON.parse(row.challenge_json); } catch { durableError(); }
      if (canonicalJson(challenge) !== row.challenge_json || challenge.challenge_id !== row.challenge_id
          || challenge.episode_id !== row.episode_id || challenge.predecessor_state_digest !== row.predecessor_state_digest) durableError();
      validateReadinessChallengeV1(challenge);
      return challenge;
    });
    const verifiedEpisodes = database.prepare('SELECT * FROM episodes').all();
    verifiedEpisodes.forEach(verifyEpisodeRow);
    verifiedChallenges.forEach(challenge => {
      const episode = verifiedEpisodes.find(row => row.episode_id === challenge.episode_id);
      if (episode === undefined || challenge.mandate_digest !== episode.mandate_digest
          || challenge.authorization_digest !== episode.authorization_digest
          || challenge.executor_release_sha256 !== episode.executor_release_sha256) {
        durableError('readiness challenge authority identity does not match its durable episode binding');
      }
    });
    const episodeCount = database.prepare('SELECT COUNT(*) AS count FROM episodes').get()?.count;
    const stateCount = database.prepare('SELECT COUNT(*) AS count FROM episode_states').get()?.count;
    const unboundStates = database.prepare(`SELECT COUNT(*) AS count FROM episode_states s
      LEFT JOIN episodes e ON e.episode_id=s.episode_id WHERE e.episode_id IS NULL`).get()?.count;
    const missingStates = database.prepare(`SELECT COUNT(*) AS count FROM episodes e
      LEFT JOIN episode_states s ON s.episode_id=e.episode_id WHERE s.episode_id IS NULL`).get()?.count;
    if ((!initialize && episodeCount === 0) || episodeCount !== stateCount
        || unboundStates !== 0 || missingStates !== 0) durableError();
    const verifiedOrdinals = database.prepare('SELECT * FROM ordinals ORDER BY episode_id, ordinal').all();
    verifiedOrdinals.forEach(row => {
      verifyOrdinalRow(row);
      if (row.signed_wire_sha256 !== null) readVerifiedSignedWire(root, row);
    });
    const verifiedRevocations = database.prepare('SELECT * FROM revocations').all();
    verifiedRevocations.forEach(verifyRevocationRow);
    for (const state of verifiedStates) {
      const episode = verifiedEpisodes.find(row => row.episode_id === state.episode_id);
      if (episode === undefined || episode.mandate_digest !== state.mandate_digest
          || episode.authorization_digest !== state.authorization_digest) {
        durableError('episode state authority identity does not match its durable episode binding');
      }
      const ordinals = verifiedOrdinals.filter(row => row.episode_id === state.episode_id);
      const revocations = verifiedRevocations.filter(row => row.episode_id === state.episode_id);
      if (ordinals.length !== state.consumed_decision_ids.length || ordinals.length !== state.consumed_challenge_ids.length
          || ordinals.some((row, index) => row.ordinal !== index + 1
            || row.phase !== (index === 0 ? 'ACQUISITION' : 'DISPOSAL')
            || row.predecessor_state !== (index === 0 ? 'AUTHORIZED_DORMANT' : 'ACQUISITION_EVIDENCE_CLOSED')
            || row.decision_id !== state.consumed_decision_ids[index]
            || row.challenge_id !== state.consumed_challenge_ids[index]
            || !verifiedChallenges.some(challenge => challenge.challenge_id === row.challenge_id
              && challenge.episode_id === row.episode_id
              && challenge.predecessor_state_digest === row.predecessor_state_digest))
          || revocations.length > 1) durableError('episode state/ordinal/revocation cross-product is inconsistent');
      ordinals.forEach(assertOrdinalStageShape);
      assertOrdinalSuccessors(state, ordinals);
      assertStateOrdinalStages(state, ordinals);
      const revocation = revocations[0];
      if (state.human_revocation_status === 'REVOKED' && revocation === undefined) durableError('revoked episode is missing its authenticated revocation');
      if (revocation !== undefined) {
        if (!DIGEST.test(revocation.authenticated_revocation_digest)
            || !DIGEST.test(revocation.predecessor_state_digest)
            || !DIGEST.test(revocation.revoked_state_digest)
            || !Number.isSafeInteger(revocation.revoked_at_unix_seconds) || revocation.revoked_at_unix_seconds < 0) durableError();
        if (state.human_revocation_status === 'NOT_REVOKED') {
          const active = ordinals.at(-1);
          if (revocation.predecessor_state !== state.state || revocation.predecessor_state_digest !== state.state_digest
              || active?.stage !== 'KEY_LOAD_STARTED_AMBIGUOUS') durableError('nonterminal revocation must identify an ambiguous key-load checkpoint');
          const expected = applyHumanRevocationV1({ state, authorization_digest: state.authorization_digest });
          if (expected.state_digest !== revocation.revoked_state_digest) durableError();
        } else {
          assertRevocationBindsState(state, ordinals, revocation);
        }
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database?.close(); } catch {}
    if (error?.name === 'VerificationScopeError') throw error;
    durableError();
  }

  const getEpisode = database.prepare('SELECT * FROM episodes WHERE episode_id = ?');
  const getEpisodeState = database.prepare('SELECT * FROM episode_states WHERE episode_id = ?');
  const insertEpisodeState = database.prepare('INSERT INTO episode_states(episode_id,state_digest,state_json) VALUES (?,?,?)');
  const updateEpisodeState = database.prepare('UPDATE episode_states SET state_digest=?, state_json=? WHERE episode_id=? AND state_digest=?');
  const getChallenge = database.prepare('SELECT * FROM readiness_challenges WHERE challenge_id = ?');
  const insertChallenge = database.prepare(`INSERT INTO readiness_challenges(
    challenge_id,episode_id,predecessor_state_digest,challenge_json) VALUES (?,?,?,?)`);
  const getOrdinal = database.prepare('SELECT * FROM ordinals WHERE episode_id = ? AND ordinal = ?');
  const getReplayedIdentity = database.prepare('SELECT * FROM ordinals WHERE decision_id = ? OR challenge_id = ? LIMIT 1');
  const getRevocation = database.prepare('SELECT * FROM revocations WHERE episode_id = ?');
  const insertEpisode = database.prepare('INSERT INTO episodes VALUES (?, ?, ?, ?, ?)');
  const insertOrdinal = database.prepare('INSERT INTO ordinals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertRevocation = database.prepare('INSERT INTO revocations VALUES (?, ?, ?, ?, ?, ?, ?)');
  const updateOrdinal = database.prepare(`UPDATE ordinals SET stage = ?, prepared_transaction_digest = ?,
    signed_intent_digest = ?, semantic_transaction_digest = ?, message_sha256 = ?, transaction_signature = ?, signed_wire_sha256 = ?, signed_wire_path = ?, finalized_evidence_digest = ?,
    row_digest = ? WHERE episode_id = ? AND ordinal = ?`);

  function transaction(operation) {
    try {
      database.exec('BEGIN IMMEDIATE');
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch {}
      if (error?.name === 'VerificationScopeError') throw error;
      durableError();
    }
  }
  function ensureEpisode(value, { allowCreate = false } = {}) {
    let row = getEpisode.get(value.episode_id);
    if (row === undefined) {
      if (!allowCreate) durableError('required durable episode authority record is missing');
      row = {
        episode_id: value.episode_id,
        mandate_digest: value.mandate_digest,
        authorization_digest: value.authorization_digest,
        executor_release_sha256: value.executor_release_sha256,
      };
      row.row_digest = episodeDigest(row);
      insertEpisode.run(row.episode_id, row.mandate_digest, row.authorization_digest, row.executor_release_sha256, row.row_digest);
      return row;
    }
    verifyEpisodeRow(row);
    if (!bindingMatches(row, value)) durableError('episode authority binding conflicts with durable state');
    return row;
  }
  function verifiedStateForEpisode(episodeId) {
    const row = getEpisodeState.get(episodeId);
    if (row === undefined) durableError('durable episode state is missing');
    let state;
    try { state = JSON.parse(row.state_json); } catch { durableError(); }
    if (state.state_digest !== row.state_digest || canonicalJson(state) !== row.state_json) durableError();
    validateBoundedAgentEpisodeStateV1(state);
    return { row, state };
  }
  function updateState(predecessor, successor) {
    const stateJson = canonicalJson(successor);
    const result = updateEpisodeState.run(successor.state_digest, stateJson, successor.episode_id, predecessor.state_digest);
    if (Number(result.changes) !== 1) durableError('durable episode state transition failed');
  }
  function checkpoint(value, expectedStage, nextStage, { blockIfRevoked = false } = {}) {
    validateCheckpoint(value);
    return transaction(() => {
      const row = getOrdinal.get(value.episode_id, value.ordinal);
      verifyOrdinalRow(row);
      const revocation = getRevocation.get(value.episode_id);
      verifyRevocationRow(revocation);
      if (blockIfRevoked && revocation !== undefined) {
        fail('bounded_agent_authorization_revoked', 'durable revocation prevents key loading');
      }
      if (row.stage !== expectedStage || row.admission_digest !== value.admission_digest
          || (row.prepared_transaction_digest !== null && row.prepared_transaction_digest !== value.prepared_transaction_digest)) {
        fail('bounded_agent_durable_transition_invalid', 'durable execution checkpoint cannot move backward, repeat, or change identity');
      }
      const changed = { ...row, stage: nextStage, prepared_transaction_digest: value.prepared_transaction_digest };
      changed.row_digest = ordinalDigest(changed);
      updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
        changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
        changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
        changed.row_digest, changed.episode_id, changed.ordinal);
      return nextStage;
    });
  }

  if (initialize) {
    const state = provisioning?.initial_episode_state;
    validateBoundedAgentEpisodeStateV1(state);
    if (state.state !== 'AUTHORIZED_DORMANT' || state.next_ordinal !== 1
        || state.consumed_decision_ids.length !== 0 || state.consumed_challenge_ids.length !== 0) {
      durableError('provisioning requires the unique untouched AUTHORIZED_DORMANT episode state');
    }
    requireDigest(provisioning?.executor_release_sha256, 'executor_release_sha256');
    transaction(() => {
      ensureEpisode({
        episode_id: state.episode_id,
        mandate_digest: state.mandate_digest,
        authorization_digest: state.authorization_digest,
        executor_release_sha256: provisioning.executor_release_sha256,
      }, { allowCreate: true });
      insertEpisodeState.run(state.episode_id, state.state_digest, canonicalJson(state));
    });
  }

  return Object.freeze({
    async loadCurrentEpisodeStateV1({ episode_id }) {
      validateEpisodeId(episode_id);
      const { state } = verifiedStateForEpisode(episode_id);
      return cloneAndFreeze(state);
    },
    async recordSignedEpisodeStateV1(value) {
      assertExactFields(value, SIGNED_STATE_FIELDS, 'durable_signed_episode_state_transition');
      validateEpisodeId(value.episode_id);
      if (![1, 2].includes(value.ordinal)) durableError('signed episode ordinal is invalid');
      requireDigest(value.predecessor_state_digest, 'predecessor_state_digest');
      requireDigest(value.signed_intent_digest, 'signed_intent_digest');
      validateBoundedAgentEpisodeStateV1(value.successor_state);
      return transaction(() => {
        const { state: predecessor } = verifiedStateForEpisode(value.episode_id);
        if (predecessor.state_digest !== value.predecessor_state_digest) return 'STATE_MISMATCH';
        const ordinal = getOrdinal.get(value.episode_id, value.ordinal);
        verifyOrdinalRow(ordinal);
        if (ordinal.stage !== 'SIGNED_INTENT_DURABLE' || ordinal.signed_intent_digest !== value.signed_intent_digest) {
          fail('bounded_agent_durable_transition_invalid', 'signed episode state is not backed by durable signed bytes');
        }
        const expected = recordSignedIntentV1({ state: predecessor, signed_intent_digest: value.signed_intent_digest });
        if (canonicalJson(expected) !== canonicalJson(value.successor_state)) {
          fail('bounded_agent_durable_transition_invalid', 'signed episode successor is not the typed state-machine transition');
        }
        updateState(predecessor, value.successor_state);
        return 'UPDATED';
      });
    },
    async registerReadinessChallengeV1(challenge) {
      validateReadinessChallengeV1(challenge);
      return transaction(() => {
        const { state } = verifiedStateForEpisode(challenge.episode_id);
        const episode = getEpisode.get(challenge.episode_id);
        verifyEpisodeRow(episode);
        const phaseMatches = challenge.phase === 'ACQUISITION'
          ? state.state === 'AUTHORIZED_DORMANT'
          : state.state === 'ACQUISITION_EVIDENCE_CLOSED'
            && challenge.finalized_acquisition_evidence_digest === state.acquisition_evidence_digest
            && challenge.chain_derived_disposal_jup_raw === state.chain_derived_acquired_jup_raw;
        if (state.state_digest !== challenge.predecessor_state_digest || !phaseMatches
            || challenge.mandate_digest !== episode.mandate_digest
            || challenge.authorization_digest !== episode.authorization_digest
            || challenge.executor_release_sha256 !== episode.executor_release_sha256) {
          fail('bounded_agent_challenge_state_mismatch', 'challenge does not bind the current durable episode state');
        }
        const challengeJson = canonicalJson(challenge);
        const existing = getChallenge.get(challenge.challenge_id);
        if (existing !== undefined) {
          if (existing.challenge_json !== challengeJson) durableError('durable challenge identity conflict');
          return 'EXISTS';
        }
        insertChallenge.run(challenge.challenge_id, challenge.episode_id, challenge.predecessor_state_digest, challengeJson);
        return 'REGISTERED';
      });
    },
    async loadIssuedReadinessChallengeV1({ episode_id, challenge_id }) {
      validateEpisodeId(episode_id);
      if (typeof challenge_id !== 'string' || !CHALLENGE.test(challenge_id)) fail('bounded_agent_challenge_identity_invalid', 'challenge_id is invalid');
      const row = getChallenge.get(challenge_id);
      if (row === undefined || row.episode_id !== episode_id) fail('bounded_agent_challenge_not_issued', 'challenge was not issued by this durable authority');
      let challenge;
      try { challenge = JSON.parse(row.challenge_json); } catch { durableError(); }
      if (canonicalJson(challenge) !== row.challenge_json) durableError();
      validateReadinessChallengeV1(challenge);
      return cloneAndFreeze(challenge);
    },
    async consumeEpisodeOrdinalV1(value) {
      validateReservation(value);
      return transaction(() => {
        ensureEpisode(value);
        const exactReservationReplay = row => row.episode_id === value.episode_id
          && row.ordinal === value.ordinal && row.phase === value.phase
          && row.predecessor_state === value.predecessor_state
          && row.predecessor_state_digest === value.predecessor_state_digest
          && row.decision_id === value.decision_id && row.challenge_id === value.challenge_id
          && row.admission_digest === value.admission_digest
          && row.successor_state_digest === value.successor_state.state_digest;
        const existing = getOrdinal.get(value.episode_id, value.ordinal);
        if (existing !== undefined) {
          verifyOrdinalRow(existing);
          if (!exactReservationReplay(existing)) fail('bounded_agent_durable_identity_conflict', 'ordinal replay does not match retained reservation identity');
          return 'ALREADY_CONSUMED';
        }
        const replayedIdentity = getReplayedIdentity.get(value.decision_id, value.challenge_id);
        if (replayedIdentity !== undefined) {
          verifyOrdinalRow(replayedIdentity);
          if (!exactReservationReplay(replayedIdentity)) fail('bounded_agent_durable_identity_conflict', 'decision or challenge identity was reused by another reservation');
          return 'ALREADY_CONSUMED';
        }
        const { state: predecessor } = verifiedStateForEpisode(value.episode_id);
        if (predecessor.state !== value.predecessor_state
            || predecessor.state_digest !== value.predecessor_state_digest) return 'STATE_MISMATCH';
        requireConsumedDecisionTransition(predecessor, value.successor_state, value);
        const issuedChallenge = getChallenge.get(value.challenge_id);
        if (issuedChallenge === undefined || issuedChallenge.episode_id !== value.episode_id
            || issuedChallenge.predecessor_state_digest !== predecessor.state_digest) {
          fail('bounded_agent_challenge_not_issued', 'reservation challenge is not bound to current durable state');
        }
        const revocation = getRevocation.get(value.episode_id);
        verifyRevocationRow(revocation);
        if (revocation !== undefined) return 'REVOKED';
        if (value.ordinal === 2) {
          const acquisition = getOrdinal.get(value.episode_id, 1);
          verifyOrdinalRow(acquisition);
          if (acquisition.stage !== 'FINALIZED'
              || acquisition.finalized_evidence_digest !== predecessor.acquisition_evidence_digest
              || predecessor.chain_derived_acquired_jup_raw === null) return 'STATE_MISMATCH';
        }
        const row = {
          ...value,
          stage: 'RESERVED',
          prepared_transaction_digest: null,
          signed_intent_digest: null,
          semantic_transaction_digest: null,
          message_sha256: null,
          transaction_signature: null,
          signed_wire_sha256: null,
          signed_wire_path: null,
          finalized_evidence_digest: null,
          successor_state_digest: value.successor_state.state_digest,
        };
        row.row_digest = ordinalDigest(row);
        insertOrdinal.run(row.episode_id, row.ordinal, row.phase, row.predecessor_state, row.predecessor_state_digest,
          row.decision_id, row.challenge_id, row.admission_digest, row.successor_state_digest, row.stage,
          row.prepared_transaction_digest, row.signed_intent_digest, row.semantic_transaction_digest,
          row.message_sha256, row.transaction_signature, row.signed_wire_sha256,
          row.signed_wire_path, row.finalized_evidence_digest, row.row_digest);
        updateState(predecessor, value.successor_state);
        return 'CONSUMED';
      });
    },
    async revokeAuthorizationV1(value) {
      validateRevocation(value);
      return transaction(() => {
        ensureEpisode(value);
        const existing = getRevocation.get(value.episode_id);
        if (existing !== undefined) {
          verifyRevocationRow(existing);
          if (existing.predecessor_state === value.predecessor_state
              && existing.predecessor_state_digest === value.predecessor_state_digest
              && existing.revoked_state_digest === value.revoked_state_digest
              && existing.revoked_at_unix_seconds === value.revoked_at_unix_seconds
              && existing.authenticated_revocation_digest === value.revocation_digest) return 'ALREADY_REVOKED';
          fail('bounded_agent_revocation_conflict', 'a different durable revocation already exists for this episode');
        }
        const { state: predecessor } = verifiedStateForEpisode(value.episode_id);
        if (predecessor.state !== value.predecessor_state
            || predecessor.state_digest !== value.predecessor_state_digest) return 'STATE_MISMATCH';
        const expectedSuccessor = applyHumanRevocationV1({
          state: predecessor,
          authorization_digest: value.authorization_digest,
        });
        if (expectedSuccessor.state_digest !== value.revoked_state_digest
            || canonicalJson(expectedSuccessor) !== canonicalJson(value.successor_state)) {
          fail('bounded_agent_durable_transition_invalid', 'revocation successor is not the typed state-machine transition');
        }
        const ordinals = database.prepare('SELECT * FROM ordinals WHERE episode_id = ? ORDER BY ordinal').all(value.episode_id);
        ordinals.forEach(verifyOrdinalRow);
        const expectedCount = value.predecessor_state === 'AUTHORIZED_DORMANT' ? 0
          : ['ACQUISITION_ADMITTED', 'ACQUISITION_EVIDENCE_CLOSED', 'ACQUISITION_SUBMISSION_RESOLVING']
            .includes(value.predecessor_state) ? 1 : 2;
        if (ordinals.length !== expectedCount) return 'STATE_MISMATCH';
        if (value.predecessor_state === 'ACQUISITION_ADMITTED'
            && !['RESERVED', 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE'].includes(ordinals[0]?.stage)) return 'STATE_MISMATCH';
        if (value.predecessor_state === 'ACQUISITION_EVIDENCE_CLOSED'
            && ordinals[0]?.stage !== 'FINALIZED') return 'STATE_MISMATCH';
        if (value.predecessor_state === 'DISPOSAL_ADMITTED'
            && !['RESERVED', 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE'].includes(ordinals[1]?.stage)) return 'STATE_MISMATCH';
        if (value.predecessor_state === 'ACQUISITION_SUBMISSION_RESOLVING'
            && !['KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE'].includes(ordinals[0]?.stage)) return 'STATE_MISMATCH';
        if (value.predecessor_state === 'DISPOSAL_SUBMISSION_RESOLVING'
            && !['KEY_LOAD_STARTED_AMBIGUOUS', 'SIGNED_INTENT_DURABLE', 'SUBMISSION_POSSIBLE'].includes(ordinals[1]?.stage)) return 'STATE_MISMATCH';
        const row = {
          episode_id: value.episode_id,
          predecessor_state: value.predecessor_state,
          predecessor_state_digest: value.predecessor_state_digest,
          revoked_state_digest: value.revoked_state_digest,
          revoked_at_unix_seconds: value.revoked_at_unix_seconds,
          authenticated_revocation_digest: value.revocation_digest,
        };
        row.row_digest = revocationDigest(row);
        insertRevocation.run(row.episode_id, row.predecessor_state, row.predecessor_state_digest,
          row.revoked_state_digest, row.revoked_at_unix_seconds, row.authenticated_revocation_digest, row.row_digest);
        const activeOrdinal = value.predecessor_state.startsWith('ACQUISITION') ? ordinals[0]
          : value.predecessor_state.startsWith('DISPOSAL') ? ordinals[1] : undefined;
        if (activeOrdinal?.stage === 'KEY_LOAD_STARTED_AMBIGUOUS') {
          return 'REVOCATION_RECORDED_SIGNING_AMBIGUOUS';
        }
        if (activeOrdinal?.stage === 'SIGNED_INTENT_DURABLE') {
          readVerifiedSignedWire(root, activeOrdinal);
          const signedState = recordSignedIntentV1({ state: predecessor, signed_intent_digest: activeOrdinal.signed_intent_digest });
          const resolvingRevoked = applyHumanRevocationV1({ state: signedState, authorization_digest: value.authorization_digest });
          updateState(predecessor, resolvingRevoked);
          return 'REVOKED_SIGNED_BYTES_DURABLE';
        }
        updateState(predecessor, value.successor_state);
        return 'REVOKED';
      });
    },
    async recordPreparedV1(value) {
      assertExactFields(value, PREPARED_FIELDS, 'durable_prepared_transaction');
      validateCheckpoint(Object.fromEntries(CHECKPOINT_FIELDS.map(field => [field, value[field]])));
      requireDigest(value.semantic_transaction_digest, 'semantic_transaction_digest');
      return transaction(() => {
        const row = getOrdinal.get(value.episode_id, value.ordinal);
        verifyOrdinalRow(row);
        if (row.stage !== 'RESERVED' || row.admission_digest !== value.admission_digest
            || row.prepared_transaction_digest !== null || row.semantic_transaction_digest !== null) {
          fail('bounded_agent_durable_transition_invalid', 'prepared transaction cannot move backward, repeat, or change identity');
        }
        const changed = { ...row, stage: 'PREPARED', prepared_transaction_digest: value.prepared_transaction_digest,
          semantic_transaction_digest: value.semantic_transaction_digest };
        changed.row_digest = ordinalDigest(changed);
        updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
          changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
          changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
          changed.row_digest, changed.episode_id, changed.ordinal);
        return changed.stage;
      });
    },
    async recordKeyLoadStartedV1(value) {
      return checkpoint(value, 'PREPARED', 'KEY_LOAD_STARTED_AMBIGUOUS', { blockIfRevoked: true });
    },
    async recordSignedIntentDurableV1(value) {
      assertExactFields(value, SIGNED_FIELDS, 'durable_signed_intent');
      validateCheckpoint(Object.fromEntries(CHECKPOINT_FIELDS.map(field => [field, value[field]])));
      requireDigest(value.signed_intent_digest, 'signed_intent_digest');
      requireDigest(value.semantic_transaction_digest, 'semantic_transaction_digest');
      requireDigest(value.message_sha256, 'message_sha256');
      if (typeof value.transaction_signature !== 'string' || value.transaction_signature.length < 32) {
        durableError('transaction signature is invalid');
      }
      requireDigest(value.signed_wire_sha256, 'signed_wire_sha256');
      readVerifiedSignedWire(root, value);
      return transaction(() => {
        const row = getOrdinal.get(value.episode_id, value.ordinal);
        verifyOrdinalRow(row);
        if (row.stage !== 'KEY_LOAD_STARTED_AMBIGUOUS' || row.admission_digest !== value.admission_digest
            || row.prepared_transaction_digest !== value.prepared_transaction_digest
            || row.semantic_transaction_digest !== value.semantic_transaction_digest) {
          fail('bounded_agent_durable_transition_invalid', 'signed intent does not match the reserved execution');
        }
        const changed = {
          ...row,
          stage: 'SIGNED_INTENT_DURABLE',
          signed_intent_digest: value.signed_intent_digest,

          message_sha256: value.message_sha256,
          transaction_signature: value.transaction_signature,
          signed_wire_sha256: value.signed_wire_sha256,
          signed_wire_path: value.signed_wire_path,
        };
        changed.row_digest = ordinalDigest(changed);
        updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
          changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
          changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
          changed.row_digest, changed.episode_id, changed.ordinal);
        const revocation = getRevocation.get(value.episode_id);
        verifyRevocationRow(revocation);
        if (revocation !== undefined) {
          const { state: admittedState } = verifiedStateForEpisode(value.episode_id);
          const signedState = recordSignedIntentV1({ state: admittedState, signed_intent_digest: value.signed_intent_digest });
          const resolvingRevoked = applyHumanRevocationV1({ state: signedState, authorization_digest: admittedState.authorization_digest });
          updateState(admittedState, resolvingRevoked);
          return 'SIGNED_AFTER_REVOCATION_DURABLE';
        }
        return changed.stage;
      });
    },
    async recordSubmissionPossibleV1(value) {
      assertExactFields(value, SUBMISSION_FIELDS, 'durable_submission_possible');
      if (!EPISODE.test(value.episode_id) || ![1, 2].includes(value.ordinal)) durableError('submission identity is invalid');
      for (const field of ['signed_intent_digest', 'signed_wire_sha256']) requireDigest(value[field], field);
      return transaction(() => {
        const row = getOrdinal.get(value.episode_id, value.ordinal);
        verifyOrdinalRow(row);
        const revocation = getRevocation.get(value.episode_id);
        verifyRevocationRow(revocation);
        if (revocation !== undefined) fail('bounded_agent_authorization_revoked', 'durable revocation prevents first submission');
        if (row.stage !== 'SIGNED_INTENT_DURABLE' || row.signed_intent_digest !== value.signed_intent_digest
            || row.signed_wire_sha256 !== value.signed_wire_sha256) fail('bounded_agent_durable_transition_invalid', 'submission identity is invalid');
        readVerifiedSignedWire(root, row);
        const changed = { ...row, stage: 'SUBMISSION_POSSIBLE' };
        changed.row_digest = ordinalDigest(changed);
        updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
          changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
          changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
          changed.row_digest, changed.episode_id, changed.ordinal);
        return changed.stage;
      });
    },
    async closeAcquisitionFromFinalizedEvidenceV1(proof) {
      if (!isAuthoritativeAcquisitionClosureProofV1(proof)) {
        fail('bounded_agent_acquisition_closure_capability_denied', 'acquisition closure requires a source-authoritative proof');
      }
      return transaction(() => {
        const { state: predecessor } = verifiedStateForEpisode(proof.episode_id);
        if (!['ACQUISITION_SUBMISSION_RESOLVING', 'RESOLUTION_REQUIRED_AFTER_REVOCATION'].includes(predecessor.state)) {
          fail('bounded_agent_durable_transition_invalid', 'acquisition closure predecessor is invalid');
        }
        const row = getOrdinal.get(proof.episode_id, 1);
        verifyOrdinalRow(row);
        if (row.stage !== 'SUBMISSION_POSSIBLE'
            || row.signed_intent_digest !== proof.signed_intent_digest
            || row.semantic_transaction_digest !== proof.semantic_transaction_digest
            || row.message_sha256 !== proof.message_sha256
            || row.transaction_signature !== proof.signed_transaction_signature
            || row.signed_wire_sha256 !== proof.signed_wire_sha256) {
          fail('bounded_agent_durable_transition_invalid', 'acquisition closure does not bind the durable signed submission');
        }
        readVerifiedSignedWire(root, row);
        const successor = closeFinalizedLegV1({
          state: predecessor,
          phase: 'ACQUISITION',
          finalized_evidence_digest: proof.finalized_evidence_digest,
          chain_derived_acquired_jup_raw: proof.chain_derived_acquired_jup_raw,
        });
        const changed = { ...row, stage: 'FINALIZED', finalized_evidence_digest: proof.finalized_evidence_digest };
        changed.row_digest = ordinalDigest(changed);
        updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
          changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
          changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
          changed.row_digest, changed.episode_id, changed.ordinal);
        updateState(predecessor, successor);
        return cloneAndFreeze(successor);
      });
    },
    async recordFinalizedV1(value) {
      assertExactFields(value, FINALIZED_FIELDS, 'durable_finalization');
      if (!EPISODE.test(value.episode_id) || value.ordinal !== 2) durableError('direct acquisition finalization is forbidden');
      for (const field of ['signed_intent_digest', 'signed_wire_sha256', 'finalized_evidence_digest']) requireDigest(value[field], field);
      return transaction(() => {
        const { state: predecessor } = verifiedStateForEpisode(value.episode_id);
        const row = getOrdinal.get(value.episode_id, value.ordinal);
        verifyOrdinalRow(row);
        if (row.stage !== 'SUBMISSION_POSSIBLE' || row.signed_intent_digest !== value.signed_intent_digest
            || row.signed_wire_sha256 !== value.signed_wire_sha256) fail('bounded_agent_durable_transition_invalid', 'finalization identity is invalid');
        readVerifiedSignedWire(root, row);
        const successor = closeFinalizedLegV1({
          state: predecessor, phase: 'DISPOSAL', finalized_evidence_digest: value.finalized_evidence_digest,
        });
        const changed = { ...row, stage: 'FINALIZED', finalized_evidence_digest: value.finalized_evidence_digest };
        changed.row_digest = ordinalDigest(changed);
        updateOrdinal.run(changed.stage, changed.prepared_transaction_digest, changed.signed_intent_digest,
          changed.semantic_transaction_digest, changed.message_sha256, changed.transaction_signature,
          changed.signed_wire_sha256, changed.signed_wire_path, changed.finalized_evidence_digest,
          changed.row_digest, changed.episode_id, changed.ordinal);
        updateState(predecessor, successor);
        return changed.stage;
      });
    },
    async inspectEpisodeV1({ episode_id }) {
      if (typeof episode_id !== 'string' || !EPISODE.test(episode_id)) durableError('episode identity is invalid');
      try {
        const episode = getEpisode.get(episode_id);
        verifyEpisodeRow(episode);
        const ordinals = database.prepare('SELECT * FROM ordinals WHERE episode_id = ? ORDER BY ordinal').all(episode_id);
        ordinals.forEach(row => {
          verifyOrdinalRow(row);
          if (row.signed_wire_sha256 !== null) readVerifiedSignedWire(root, row);
        });
        const revocation = getRevocation.get(episode_id);
        verifyRevocationRow(revocation);
        return Object.freeze({
          authority_version: VERSION,
          episode_id,
          revoked: revocation !== undefined,
          revocation: revocation === undefined ? null : Object.freeze({
            predecessor_state: revocation.predecessor_state,
            predecessor_state_digest: revocation.predecessor_state_digest,
            revoked_state_digest: revocation.revoked_state_digest,
            revoked_at_unix_seconds: revocation.revoked_at_unix_seconds,
            authenticated_revocation_digest: revocation.authenticated_revocation_digest,
          }),
          ordinals: Object.freeze(ordinals.map(row => Object.freeze({
            ordinal: row.ordinal,
            phase: row.phase,
            decision_id: row.decision_id,
            challenge_id: row.challenge_id,
            admission_digest: row.admission_digest,
            stage: row.stage,
            prepared_transaction_digest: row.prepared_transaction_digest,
            signed_intent_digest: row.signed_intent_digest,
            semantic_transaction_digest: row.semantic_transaction_digest,
            message_sha256: row.message_sha256,
            transaction_signature: row.transaction_signature,
            signed_wire_sha256: row.signed_wire_sha256,
            signed_wire_path: row.signed_wire_path,
            finalized_evidence_digest: row.finalized_evidence_digest,
          }))),
        });
      } catch (error) {
        if (error?.name === 'VerificationScopeError') throw error;
        durableError();
      }
    },
    closeV1() {
      if (closed) return;
      try {
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        database.close();
        const rootDescriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(rootDescriptor); } finally { closeSync(rootDescriptor); }
        closed = true;
      } catch { durableError(); }
    },
  });
}

export function provisionCrashDurableDecisionAuthorityV1(input) {
  assertExactFields(input, ['state_root', 'initial_episode_state', 'executor_release_sha256'], 'durable_authority_provisioning');
  const authority = openCrashDurableDecisionAuthorityV1({
    state_root: input.state_root,
    initialize: true,
    provisioning: {
      initial_episode_state: input.initial_episode_state,
      executor_release_sha256: input.executor_release_sha256,
    },
  });
  authority.closeV1();
  return 'PROVISIONED';
}

export function createCrashDurableDecisionAuthorityV1(input) {
  assertExactFields(input, ['state_root'], 'durable_authority_runtime_open');
  return openCrashDurableDecisionAuthorityV1({ state_root: input.state_root });
}
