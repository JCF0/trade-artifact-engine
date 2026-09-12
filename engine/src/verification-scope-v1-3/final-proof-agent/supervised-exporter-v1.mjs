import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { assertExactFields, canonicalJson, cloneAndFreeze, sha256CanonicalJson } from '../contract.mjs';
import { admitAgentDecisionStateV1 } from './episode-state-machine-v1.mjs';
import { buildRetainedFinalizedSourceV1 } from './final-episode-release-v1.mjs';
import { createProductionPositionEconomicEvidencePortV13 } from '../production-position-economic-evidence-bridge-v1-3.mjs';
import { buildEpisodeCandidatePopulationV13 } from '../episode-candidate-population.mjs';
import { computeCandidateMemberDigestV13 } from '../explicit-candidate-selection.mjs';
import { loadRetainedEpisodePackageV1 } from './retained-episode-package-v1.mjs';
import { inspectSignedLegacyWire } from './reused/bounded-rebroadcast-v1.mjs';
import { validateHumanRevocationV1 } from './human-revocation-v1.mjs';
import { isRecoveredSetupExecutorMandateV2 } from './executor-mandate-profile-v1.mjs';
import { validateExecutorRecoveredSetupEvidenceV2 as validateRecoveredSetupEvidenceV2 } from './recovered-setup-v2.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
function stop() { throw Error('SUPERVISED_EXPORT_INVALID'); }
function read(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) || s.size > 8 * 1024 * 1024) stop();
    const bytes = readFileSync(fd), after = fstatSync(fd);
    if (bytes.length !== s.size || after.mtimeMs !== s.mtimeMs || after.size !== s.size) stop();
    return bytes;
  } finally { closeSync(fd); }
}
function children(root) {
  const members = [];
  function walk(relative) {
    const path = relative ? join(root, relative) : root, st = lstatSync(path);
    if (st.isSymbolicLink() || (st.mode & 0o077)) stop();
    if (st.isDirectory()) { for (const name of readdirSync(path).sort()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)) stop(); walk(relative ? `${relative}/${name}` : name);
    } } else members.push({ path: relative, bytes: read(path) });
    if (members.length > 512) stop();
  }
  walk(''); return members;
}
function source(journal, ordinal) {
  const records = journal.snapshot().records, found = records.filter(r => r.kind === 'economic_source' && r.ordinal === ordinal);
  if (found.length !== 1) stop();
  const d = cloneAndFreeze(found[0].descriptor), files = new Map(found[0].members.map(m => [m.path, Buffer.from(m.base64, 'base64')]));
  const loaded = { readMemberV1(name) { if (!files.has(name)) stop(); return Buffer.from(files.get(name)); },
    parseMemberV1(name) { return JSON.parse(this.readMemberV1(name)); } };
  return { descriptor: d, files, loaded, records };
}
export async function inspectSupervisedExportCandidatesV1({ c, journal, ordinal }) {
  if (![1, 2].includes(ordinal)) stop();
  const s = source(journal, ordinal), captured = await buildRetainedFinalizedSourceV1(s.loaded, s.descriptor, { mandate: c.mandate, authorization: c.authorization });
  const economic = await createProductionPositionEconomicEvidencePortV13({ evidence_context: captured.context,
    context_authority: captured.authority, exact_quote_mint: c.mandate.asset_scope.usdc_mint });
  return buildEpisodeCandidatePopulationV13({ context: captured.context, context_authority: captured.authority,
    exact_quote_mint: c.mandate.asset_scope.usdc_mint, economic_evidence_port: economic });
}
// No fixture graph, signing, provider or authority mutation is available here.
// Destination is fixed beneath the already-provisioned private episode root.
export async function exportSupervisedRetainedEpisodeV1({ c, journal, authority, ordinal, selection }) {
  if (![1, 2].includes(ordinal) || (selection !== null && (typeof selection !== 'object' || !selection))) stop();
  if (selection !== null) {
    assertExactFields(selection, ['candidate_population_digest', 'requested_candidate_digest'], 'supervised_export_selection');
    const population = await inspectSupervisedExportCandidatesV1({ c, journal, ordinal });
    if (selection.candidate_population_digest !== population.population_digest
      || !population.episode_dispositions.some(episode_disposition => computeCandidateMemberDigestV13({
        candidate_population_digest: population.population_digest, episode_disposition }) === selection.requested_candidate_digest)) stop();
  }
  const snapshot = journal.snapshot(), s = source(journal, ordinal), files = s.files;
  const put = (path, bytes) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(path) || files.has(path)) stop();
    const b = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(canonicalJson(bytes));
    if (b.length > 8 * 1024 * 1024) stop(); files.set(path, b); return path;
  };
  const episodeId = `bounded-agent-episode-${c.authorization.authorization_digest}`;
  const state = await authority.inspectEpisodeV1({ episode_id: episodeId });
  const requests = s.records.filter(r => r.kind === 'authenticated_decision_request').map(r => r.record);
  const ready = s.records.filter(r => r.kind === 'readiness').map(r => r.record);
  const captures = ready.filter(r => r.classification === 'EXECUTOR_CAPTURE_PROVIDER_ATTESTED_NOT_ATOMIC');
  const raw = new Map(ready.filter(r => r.request).map(r => [sha256CanonicalJson(r), r]));
  const legs = [];
  for (const n of [1, 2]) {
    const row = state.ordinals.find(r => r.ordinal === n);
    if (!row) break; // Rejected, unconsumed requests remain in the full journal.
    const matches = [];
    for (const observed of requests) {
      if (observed.challenge.ordinal !== n || observed.challenge.challenge_id !== row.challenge_id
        || observed.decision.decision_id !== row.decision_id) continue;
      try {
        const result = admitAgentDecisionStateV1({ state: observed.state, mandate: c.mandate,
          authorization: c.authorization, challenge: observed.challenge, decision: observed.decision,
          executor_release_sha256: c.executor_release_sha256, now_unix_seconds: observed.admitted_at_unix_seconds });
        if (result.admission.admission_digest === row.admission_digest) matches.push({ observed, result });
      } catch (error) { if (error?.name !== 'VerificationScopeError') throw error; }
    }
    if (!matches.length || matches.some(v => canonicalJson(v) !== canonicalJson(matches[0]))) stop();
    const { observed, result } = matches[0];
    const capture = captures.find(r => r.challenge.challenge_digest === observed.challenge.challenge_digest);
    if (!capture) stop();
    const record_members = capture.raw_evidence_digests.map((digest, i) => { if (!raw.has(digest)) stop(); return put(`leg-${n}-capture-record-${i}.json`, raw.get(digest)); });
    let signed = null, wire_member = null;
    if (row?.signed_wire_sha256) {
      if (row.admission_digest !== result.admission.admission_digest) stop();
      const wire = await authority.readRetainedWireV1({ episode_id: episodeId, ordinal: n });
      const parsed = inspectSignedLegacyWire(wire.toString('base64'));
      if (hash(wire) !== row.signed_wire_sha256 || hash(parsed.message) !== row.message_sha256 || parsed.expectedSignature !== row.transaction_signature) stop();
      signed = { signed_transaction_intent_version: 'artifact_bounded_agent_signed_transaction_intent_v1', episode_id: episodeId,
        phase: row.phase, admission_digest: row.admission_digest, semantic_transaction_digest: row.semantic_transaction_digest,
        message_sha256: row.message_sha256, signed_wire_sha256: row.signed_wire_sha256, signature: row.transaction_signature, sign_count: 1 };
      if (sha256CanonicalJson(signed) !== row.signed_intent_digest) stop();
      wire_member = put(`leg-${n}-wire.json`, { base64: wire.toString('base64') });
    }
    let submission_members = [];
    const submissionRoot = join(c.state_root, `submission-${n}`); let hasSubmission = true;
    try { lstatSync(submissionRoot); } catch (e) { if (e.code === 'ENOENT') hasSubmission = false; else throw e; }
    if (hasSubmission) submission_members = children(submissionRoot).map((m, i) => ({ path: m.path, member: put(`leg-${n}-submission-${i}.json`, m.bytes) }));
    const finalized = s.records.filter(r => r.kind === 'terminal_record' && r.record.finalized?.phase === observed.challenge.phase);
    if (finalized.length > 1) stop();
    legs.push({ challenge: observed.challenge, decision: observed.decision, admitted_at_unix_seconds: observed.admitted_at_unix_seconds,
      admission: result.admission, signed_intent: signed, wire_member, capture_member: put(`leg-${n}-capture.json`, capture),
      record_members, submission_members, finalized: finalized[0]?.record.finalized ?? null });
  }
  const journal_members = snapshot.records.map((_, i) => put(`journal-${i}.json`, read(join(c.state_root, `supervised-record-${String(i + 1).padStart(4, '0')}.json`))));
  const revocations = s.records.filter(r => r.kind === 'revocation');
  // Multiple authenticated deliveries reconcile to one durable revocation;
  // preserve every delivery, but never accept different bytes or identities.
  if (revocations.some(r => r.revocation_bytes_base64 !== revocations[0].revocation_bytes_base64)) stop();
  if (state.revoked && !revocations.length) throw Error('SUPERVISED_REVOCATION_EVIDENCE_INCOMPLETE');
  if (state.revoked !== (revocations.length > 0)) stop();
  for (const delivery of revocations) {
    const bytes = Buffer.from(delivery.revocation_bytes_base64, 'base64'), r = JSON.parse(bytes), durable = state.revocation;
    validateHumanRevocationV1(r);
    if (bytes.toString('base64') !== delivery.revocation_bytes_base64 || bytes.toString('utf8') !== canonicalJson(r)
      || r.episode_id !== episodeId || r.mandate_digest !== c.mandate.mandate_digest
      || r.authorization_digest !== c.authorization.authorization_digest || r.human_public_key !== c.authorization.human_public_key
      || r.revocation_digest !== durable.authenticated_revocation_digest || r.predecessor_state !== durable.predecessor_state
      || r.predecessor_state_digest !== durable.predecessor_state_digest || r.revoked_at_unix_seconds !== durable.revoked_at_unix_seconds) stop();
  }
  const recovered = isRecoveredSetupExecutorMandateV2(c.mandate);
  if (recovered) {
    // Historical export cannot expire already admitted evidence. The original
    // signed authorization/attestation times are checked, not the export clock.
    validateRecoveredSetupEvidenceV2({ mandate: c.mandate, authorization: c.authorization,
      evidence: c.setup_provenance, mode: 'replay' });
    put('recovered-setup.json', c.setup_provenance);
  }
  put('control.json', { version: recovered ? 'artifact_retained_control_v3' : 'artifact_retained_control_v2',
    ...(recovered ? { setup_provenance: { version: 'artifact_retained_recovered_setup_v1', evidence_member: 'recovered-setup.json' },
      runtime_deadline_unix_seconds: c.deadline_unix_seconds } : {}),
    mandate: c.mandate, authorization: c.authorization,
    configured_principals: { human_public_key: c.authorization.human_public_key, agent_public_key: c.authorization.agent_public_key,
      executor_release_sha256: c.executor_release_sha256 }, legs,
    revocation: revocations.length ? JSON.parse(Buffer.from(revocations[0].revocation_bytes_base64, 'base64')) : null,
    supervision: { phase_budgets: c.budget, journal_members, head_sha256: snapshot.journal_sha256 } });
  put('episode.json', { ...s.descriptor, selection });
  if (snapshot.journal_sha256 !== journal.snapshot().journal_sha256 || canonicalJson(state) !== canonicalJson(await authority.inspectEpisodeV1({ episode_id: episodeId }))) stop();
  if (files.size > 512 || [...files.values()].reduce((n, b) => n + b.length, 0) > 64 * 1024 * 1024) stop();
  const manifest = canonicalJson({ version: 'artifact_retained_episode_package_v1', members: [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) });
  // Private, exclusive derived destination: selection is already bound to the
  // independent population above. Never replace an earlier unselected package.
  const target = join(c.state_root, `retained-export-${ordinal}${selection === null ? '' : `-selected-${sha256CanonicalJson(selection)}`}`);
  if (realpathSync(c.state_root) !== c.state_root) stop();
  mkdirSync(target, { mode: 0o700 });
  for (const [name, bytes] of [...files, ['manifest.json', Buffer.from(manifest)]]) {
    const fd = openSync(join(target, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  const dir = openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(dir); } finally { closeSync(dir); }
  const manifest_sha256 = hash(Buffer.from(manifest));
  loadRetainedEpisodePackageV1({ root: target, expected_manifest_sha256: manifest_sha256 });
  return cloneAndFreeze({ root: target, expected_manifest_sha256: manifest_sha256, expected_evidence_kind: s.descriptor.evidence_kind, source_ordinal: ordinal });
}
