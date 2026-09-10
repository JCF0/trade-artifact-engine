// Additive source admission only. Original members are never rewritten. Outside
// window rows remain setup/history evidence, not economic transactions or proof
// that unrelated setup obligations have been discharged.
import { assertExactFields, canonicalJson, cloneAndFreeze } from '../contract.mjs';
import { deriveOldestAllowedTimestampV1 } from '../../wallet-acquisition/boundary-contract.mjs';
import { validateWalletAcquisitionRequestV2 } from '../../wallet-acquisition/request-contract.mjs';
import { validateHeliusRpcSignaturePageResponseV1 } from '../../wallet-acquisition/helius-rpc-validator.mjs';
import { validateExecutorMandateV1 } from './executor-mandate-profile-v1.mjs';
import { validateHumanEpisodeAuthorizationV1 } from './human-authorization-v1.mjs';
import { RetainedEpisodePackageError } from './retained-episode-package-v1.mjs';
const equal = (a, b) => canonicalJson(a) === canonicalJson(b);
function need(value) { if (!value) throw new RetainedEpisodePackageError('SUPERVISED_HISTORY_ADMISSION_INVALID'); }

export function admitSupervisedHistoryV1({ loaded, descriptor: d, control, anchor_slot, anchor_block_time, transactions }) {
  validateWalletAcquisitionRequestV2(d.acquisition_request);
  need(control !== null);
  const m = control.mandate;
  validateExecutorMandateV1(m);
  validateHumanEpisodeAuthorizationV1(control.authorization, { mandate: m });
  need(m.wallet_scope.wallet === d.scope.wallet);
  const oldest = deriveOldestAllowedTimestampV1({ anchor_block_time,
    requested_lookback_seconds: d.acquisition_request.window.requested_lookback_seconds });
  // The economic lookback is not the original-opening eligibility predicate.
  // Eligibility is independently replayed from the original finalized capture.
  const proof = loaded.parseMemberV1(d.history.admission);
  assertExactFields(proof, ['version', 'lanes'], 'supervised_history');
  need(proof.version === 'artifact_supervised_history_v1' && Array.isArray(proof.lanes) && proof.lanes.length === 3);
  const addresses = [m.wallet_scope.wallet, m.wallet_scope.jup_ata, m.wallet_scope.usdc_ata];
  const bodyRows = transactions.map(t => ({ signature: t.signature, slot: t.slot, block_time: t.block_time, execution_state: t.execution_state })).reverse();
  const all = [], seenAcross = new Map();
  let latestSetup = 0;
  function page(item, address, before) {
    assertExactFields(item, ['request', 'response'], 'history_member_pair');
    const request = loaded.parseMemberV1(item.request), envelope = loaded.parseMemberV1(item.response);
    assertExactFields(request, ['jsonrpc', 'id', 'method', 'params'], 'history_rpc_request');
    need((typeof request.id === 'string' || Number.isSafeInteger(request.id)) && envelope.id === request.id);
    need(equal(request, { jsonrpc: '2.0', id: request.id, method: 'getSignaturesForAddress', params: [address,
      { commitment: 'finalized', limit: 100, minContextSlot: anchor_slot, ...(before === null ? {} : { before }) }] }));
    return validateHeliusRpcSignaturePageResponseV1({ ...envelope, id: 'wallet-acquisition-v1' });
  }
  for (const [laneIndex, lane] of proof.lanes.entries()) {
    assertExactFields(lane, ['address', 'pages', 'repeated_head'], 'history_lane');
    need(lane.address === addresses[laneIndex] && Array.isArray(lane.pages)
      && lane.pages.length >= 2 && lane.pages.length <= Math.min(100, d.acquisition_request.budgets.max_pages));
    if (laneIndex === 0) need(equal(lane.pages.map(p => p.response), d.history.pages));
    let before = null, priorSlot = anchor_slot, priorTime = anchor_block_time;
    const seen = new Set(), admitted = [];
    let head;
    for (const [pageIndex, pair] of lane.pages.entries()) {
      const rows = page(pair, lane.address, before);
      if (pageIndex === 0) head = rows;
      need(pageIndex === lane.pages.length - 1 ? rows.length === 0 : rows.length > 0);
      for (const [rowIndex, row] of rows.entries()) {
        need(!seen.has(row.signature) && row.slot <= priorSlot && row.block_time <= priorTime);
        seen.add(row.signature); priorSlot = row.slot; priorTime = row.block_time;
        const existing = seenAcross.get(row.signature);
        need(existing === undefined || equal(existing, row));
        seenAcross.set(row.signature, row);
        const inWindow = row.block_time >= oldest;
        const isSetup = row.block_time <= m.setup_authority.latest_setup_block_time;
        if (!isSetup) {
          need(inWindow); // Never age unapproved post-setup activity out of evidence.
          admitted.push(row);
        } else {
          latestSetup = Math.max(latestSetup, row.block_time);
        }
        all.push({ address: lane.address, page_member: pair.response, row_index: rowIndex, ...row,
          classification: isSetup ? (inWindow ? 'IN_WINDOW_SETUP_HISTORY' : 'OUTSIDE_WINDOW_SETUP_HISTORY') : 'REQUIRED_EPISODE_TRANSACTION' });
      }
      if (rows.length) before = rows.at(-1).signature;
    }
    need(seen.size > 0);
    need(equal(page(lane.repeated_head, lane.address, null), head));
    // Fixed direct swaps reference wallet and both token accounts. Legitimate
    // cross-address overlap corroborates one body; it never doubles economics.
    need(equal(admitted, bodyRows));
  }
  need(latestSetup === m.setup_authority.latest_setup_block_time);
  return cloneAndFreeze({ version: 'artifact_supervised_history_admission_v1',
    oldest_allowed_timestamp: oldest, anchor_slot, anchor_block_time, rows: all,
    admitted: bodyRows, setup_obligation: 'ORIGINAL_AUTHENTICATED_READINESS_STILL_REQUIRED' });
}
