// Qualification sampling only: equal labels are not atomic/completeness authority.
import { canonicalJson } from '/accepted/engine/src/verification-scope-v1-3/contract.mjs';
import { put } from './bounded-successor.mjs';
export const OWNER_ROUND_POLICY = Object.freeze({ version: 'ARTIFACT_QUALIFICATION_OWNER_ROUND_V1',
  maximum_rounds: 2, restart_reason: 'VALID_WATERMARK_MISMATCH_ONLY',
  dispatch: 'SEQUENTIAL_COMPLETE_ROUND', atomic_snapshot: false,
  minimum_remaining_calls_before_restart: 20 }); // Three fresh reads + shortest full downstream (17).
const check = value => { if (!value) throw Error('QUALIFICATION_OWNER_CONTENT_OR_SHAPE_STOP'); };
const integer = n => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0);
const cfg = minContextSlot => ({ commitment: 'finalized', encoding: 'base64', minContextSlot });
function account(value, owner) {
  check(value && integer(value.lamports) && value.owner === owner && value.executable === false
    && Array.isArray(value.data) && value.data.length === 2 && value.data[1] === 'base64'
    && typeof value.data[0] === 'string' && Buffer.from(value.data[0], 'base64').toString('base64') === value.data[0]);
  check(Object.keys(value).every(key => ['lamports', 'owner', 'executable', 'data', 'rentEpoch', 'space'].includes(key))
    && (value.space === undefined || (integer(value.space) && value.space === Buffer.from(value.data[0], 'base64').length)));
  // Whole parsed-account equality below includes metadata; raw response identities
  // remain retained separately. No token decoding or production authority is issued.
}
export async function sampleOwnerRounds(session, root, anchor, scope, findings) {
  const addresses = [scope.wallet, scope.jup_ata, scope.usdc_ata];
  const programs = [scope.token, scope.token2022];
  let minimum = anchor, initialAccounts;
  put(root, 'owner-round-policy.json', OWNER_ROUND_POLICY);
  for (let round = 1; round <= OWNER_ROUND_POLICY.maximum_rounds; round++) {
    if (round > 1) session.requireCapacity(OWNER_ROUND_POLICY.minimum_remaining_calls_before_restart);
    const row = { version: OWNER_ROUND_POLICY.version, round, minimum_context_slot: minimum,
      first_ordinal: session.snapshot().consumed + 1, last_ordinal: null, observations: [],
      context_slots: [], disposition: 'ROUND_RESERVED_NO_REFUND' };
    put(root, `owner-round-${round}-reserved.json`, row);
    let opening, lanes = [], admitted = false, completed;
    async function observe(method, params, floor) {
      const first = session.snapshot().consumed + 1;
      try {
        const result = await session.call(method, params);
        check(integer(result?.context?.slot) && result.context.slot >= floor);
        row.context_slots.push(result.context.slot);
        return result;
      } finally {
        const snapshot = session.snapshot();
        row.observations.push({ method, first_ordinal: first, last_ordinal: snapshot.consumed,
          attempts: snapshot.ledger.filter(r => r.ordinal >= first).map(r => ({ ordinal: r.ordinal,
            request_identity: r.request_identity, response_identity: r.response_identity ?? null })) });
      }
    }
    try {
      opening = await observe('getMultipleAccounts', [addresses, cfg(minimum)], minimum);
      check(Array.isArray(opening.value) && opening.value.length === 3);
      opening.value.forEach((value, index) => account(value, index === 0 ? '11111111111111111111111111111111' : scope.token));
      const accounts = canonicalJson(opening.value);
      // A newer round cannot erase observed changes in the direct wallet/ATA state.
      check(initialAccounts === undefined || initialAccounts === accounts);
      initialAccounts ??= accounts;
      for (const programId of programs) {
        const lane = await observe('getTokenAccountsByOwner', [scope.wallet, { programId }, cfg(opening.context.slot)], opening.context.slot);
        check(Array.isArray(lane.value));
        for (const item of lane.value) { check(typeof item?.pubkey === 'string'); account(item.account, programId); }
        lanes.push(lane);
      }
      // Substantive validity MUST precede the retryable watermark decision.
      check(lanes[0].value.length === 2 && lanes[1].value.length === 0);
      for (const [index, address] of addresses.slice(1).entries()) {
        const matches = lanes[0].value.filter(item => item.pubkey === address);
        check(matches.length === 1 && canonicalJson(matches[0].account) === canonicalJson(opening.value[index + 1]));
      }
      admitted = lanes.every(lane => lane.context.slot === opening.context.slot);
      row.disposition = admitted ? 'ADMITTED_COMPLETE_ROUND' : 'REJECTED_VALID_WATERMARK_MISMATCH';
      minimum = Math.max(minimum, ...row.context_slots);
    } catch (error) {
      row.disposition = 'STOPPED_SUBSTANTIVE_OR_SESSION_FAILURE';
      throw error;
    } finally {
      row.last_ordinal = session.snapshot().consumed;
      completed = put(root, `owner-round-${round}-completion.json`, row);
    }
    if (admitted) {
      session.requireCapacity(1); // Do not publish admission after deadline/call exhaustion.
      const admission = { version: OWNER_ROUND_POLICY.version, round, record_identity: completed,
        opening_context_slot: opening.context.slot, atomic_snapshot: false,
        authority: 'QUALIFICATION_SAMPLE_ONLY', excluded_rounds: round === 1 ? [] : [1] };
      put(root, 'owner-round-admission.json', admission);
      findings.owner_round = admission;
      findings.equal_opening_watermarks = true;
      findings.contexts = row.context_slots.map((observed, index) => ({ round, observed,
        method: index === 0 ? 'getMultipleAccounts' : 'getTokenAccountsByOwner',
        requested: index === 0 ? row.minimum_context_slot : opening.context.slot }));
      return opening;
    }
  }
  findings.equal_opening_watermarks = false;
  throw Error('QUALIFICATION_OWNER_ROUNDS_EXHAUSTED');
}
