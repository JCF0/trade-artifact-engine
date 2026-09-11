import { constructAndSimulate } from './construction.mjs';
// Non-authoritative standard-RPC sampling, independent of episode admission.
import { createSession, loadExchange, put } from './bounded-successor.mjs';
export const PUBLIC = Object.freeze({
  genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA',
  jup_ata: '4HgYhw4FSPPGwhAs65vWFxHLyGbTNUVfZcTtKVteP6E2',
  usdc_ata: 'Db7uFgxUjDFpngThm18ho6DxK9gsFcA6AZKX8ryPPBe7',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  pool: '4Ui9QdDNuUaAGqCPcDSp191QrixLzQiLxJ1Gnqvz3szP',
  jup_vault: '9gMRWNfLXNc54ta5LxuM16p72GYap2t6rf455TTBKQW4',
  usdc_vault: 'CYcxSC2vmbScHFcTtEM6346uqMN8b9zeSGnP9qZu1E6U',
  oracle: 'CrkkeqLUo7n6gvzoYMPZ7CHjie1Zua2CHUPe2DFh8mmR',
  jup_mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  usdc_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
});
const check = condition => { if (!condition) throw Error('QUALIFICATION_CONTRACT_STOP'); };
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const config = minContextSlot => ({ commitment: 'finalized', encoding: 'base64', minContextSlot });
function atFloor(result, floor) { check(integer(result?.context?.slot) && result.context.slot >= floor); return result; }
function account(value) {
  check(value && integer(value.lamports) && typeof value.owner === 'string' && typeof value.executable === 'boolean'
    && Array.isArray(value.data) && value.data.length === 2 && value.data[1] === 'base64'
    && typeof value.data[0] === 'string' && Buffer.from(value.data[0], 'base64').toString('base64') === value.data[0]);
  // Transport-shape sampling only: no binary decoder or rentEpoch authority claim.
}
export async function probe(session, root, descriptor, setupSignatures) {
  const findings = { classification: 'PROVIDER_SAMPLE_NOT_READINESS', passed: [], not_tested: [
    'HISTORY_UNIVERSAL_COMPLETENESS', 'BROADCAST_MAX_RETRIES', 'PRODUCTION_HOST_QUALIFICATION'], contexts: [] };
  try {
    check(await session.call('getGenesisHash', []) === PUBLIC.genesis);
    findings.passed.push('AUTHENTICATED_MAINNET_GENESIS');
    const slot = await session.call('getSlot', [{ commitment: 'finalized' }]); check(integer(slot));
    const block = await session.call('getBlock', [slot, { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 }]);
    check(integer(block?.blockTime) && block.blockTime <= Math.floor(Date.now() / 1000)
      && Math.floor(Date.now() / 1000) - block.blockTime <= 300);
    findings.anchor = { slot, block_time: block.blockTime };
    findings.passed.push('FINALIZED_FRESH_ANCHOR_SAMPLE');
    const addresses = [PUBLIC.wallet, PUBLIC.jup_ata, PUBLIC.usdc_ata];
    const opening = atFloor(await session.call('getMultipleAccounts', [addresses, config(slot)]), slot);
    check(Array.isArray(opening.value) && opening.value.length === 3); opening.value.forEach(account);
    findings.contexts.push({ method: 'getMultipleAccounts', requested: slot, observed: opening.context.slot });
    const lanes = [];
    for (const programId of [PUBLIC.token, PUBLIC.token2022]) {
      const lane = atFloor(await session.call('getTokenAccountsByOwner', [PUBLIC.wallet, { programId }, config(opening.context.slot)]), opening.context.slot);
      check(Array.isArray(lane.value));
      for (const row of lane.value) { check(typeof row.pubkey === 'string'); account(row.account); }
      findings.contexts.push({ method: 'getTokenAccountsByOwner', programId, requested: opening.context.slot, observed: lane.context.slot, count: lane.value.length });
      lanes.push(lane);
    }
    findings.equal_opening_watermarks = lanes.every(l => l.context.slot === opening.context.slot);
    check(findings.equal_opening_watermarks); // Material readiness-contract contradiction is STOP, never pair retry.
    check(lanes[0].value.length === 2 && lanes[1].value.length === 0);
    for (const [index, address] of addresses.slice(1).entries()) {
      const rows = lanes[0].value.filter(row => row.pubkey === address);
      check(rows.length === 1 && JSON.stringify(rows[0].account.data) === JSON.stringify(opening.value[index + 1].data));
    }
    findings.passed.push('OWNER_LANE_SHAPE_FLOOR_AND_EQUAL_WATERMARK_SAMPLE_NOT_ATOMIC');
    for (const address of addresses) {
      const cfg = { commitment: 'finalized', limit: 100, minContextSlot: opening.context.slot };
      let before, head, exhausted = false, previous = slot;
      const seen = new Set();
      for (let page = 0; page < 4; page++) {
        const rows = await session.call('getSignaturesForAddress', [address, { ...cfg, ...(before ? { before } : {}) }]);
        check(Array.isArray(rows) && rows.length <= 100);
        if (page === 0) head = rows;
        for (const row of rows) {
          check(typeof row.signature === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(row.signature)
            && integer(row.slot) && row.slot <= previous && integer(row.blockTime)
            && row.blockTime <= block.blockTime && !seen.has(row.signature));
          seen.add(row.signature); previous = row.slot;
        }
        if (!rows.length) { exhausted = true; break; }
        before = rows.at(-1).signature;
      }
      check(exhausted && seen.size > 0);
      const repeat = await session.call('getSignaturesForAddress', [address, cfg]);
      check(JSON.stringify(repeat) === JSON.stringify(head));
      findings.passed.push(`BOUNDED_HISTORY_EXHAUSTED_STABLE_HEAD:${address}`);
    }
    check(Array.isArray(setupSignatures) && setupSignatures.length === 2 && new Set(setupSignatures).size === 2);
    for (const signature of setupSignatures) {
      check(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature));
      const tx = await session.call('getTransaction', [signature, { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 }]);
      check(tx && integer(tx.slot) && tx.slot <= slot && integer(tx.blockTime)
        && tx.blockTime <= descriptor.latest_setup_block_time && tx.meta?.err === null
        && tx.transaction?.signatures?.includes(signature)
        && tx.transaction?.message?.accountKeys?.some(key => [PUBLIC.wallet, PUBLIC.jup_ata, PUBLIC.usdc_ata].includes(key)));
    }
    findings.passed.push('TWO_RETAINED_SETUP_BODY_SAMPLES');
    findings.simulation = await constructAndSimulate(session, descriptor, opening.context.slot, root);
    findings.disposition = 'PARTIAL_QUALIFICATION_ONLY';
  } catch { findings.disposition = 'STOPPED_PARTIAL_EVIDENCE'; }
  finally { session.close(); put(root, 'findings.json', findings); put(root, 'ledger.json', session.snapshot()); }
  return findings;
}
