#!/usr/bin/env node

import assert from 'assert';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import { buildInventorySnapshot } from '../inventory/inventory.mjs';
import { buildShareCardViewModel } from './share-card-view-model.mjs';

export const PRODUCTION_SHARE_CARD_EXPECTATIONS = Object.freeze({
  JUP: Object.freeze({
    receipt_hash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
    receipt_id: 'art_v12_cp_JUPyiwrY_0',
    token_mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    quote_symbol: 'USDC',
    display_status: 'Verified Closed Position',
    first_event_at: 1781904268,
    last_event_at: 1782068814,
    hold_time_seconds: 164546,
    realized_pnl_quote: 8287.838847,
    realized_pnl_pct: 16.6661,
    avg_buy_quote_price: 0.186984197483,
    avg_sell_quote_price: 0.21814718953,
    total_sold_qty: 265951.319268,
    allocated_cost_basis_quote: 49728.694003,
    total_sold_quote: 58016.53285,
    accounting_method: 'weighted_average_position_accounting_v1',
    num_buys: 1,
    num_sells: 1,
    summary: 'JUP/USDC | +8287.838847 USDC | +16.6661% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
  }),
  RAY: Object.freeze({
    receipt_hash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
    receipt_id: 'art_v12_cp_4k3Dyjzv_0',
    token_mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    quote_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    quote_symbol: 'USDT',
    display_status: 'Verified Closed Position',
    first_event_at: 1769382291,
    last_event_at: 1769632666,
    hold_time_seconds: 250375,
    realized_pnl_quote: 2347.717902,
    realized_pnl_pct: 9.39087,
    avg_buy_quote_price: 0.938269683768,
    avg_sell_quote_price: 1.02638138511,
    total_sold_qty: 26644.791399,
    allocated_cost_basis_quote: 25000,
    total_sold_quote: 27347.717902,
    accounting_method: 'weighted_average_position_accounting_v1',
    num_buys: 1,
    num_sells: 1,
    summary: 'RAY/USDT | +2347.717902 USDT | +9.39087% | weighted_average_position_accounting_v1 | 1 buy / 1 sell',
  }),
});

function requireExplicitRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`An explicit ${label} root is required`);
  }
  return resolve(value);
}

function assertExactProductionReceipt(receipt, expected) {
  assert.ok(receipt, `production receipt absent: ${expected.receipt_hash}`);
  for (const field of [
    'receipt_hash',
    'receipt_id',
    'token_mint',
    'quote_mint',
    'quote_symbol',
    'display_status',
    'first_event_at',
    'last_event_at',
  ]) {
    assert.strictEqual(receipt[field], expected[field], `${expected.receipt_id}.${field}`);
  }
  assert.strictEqual(receipt.receipt_type, 'closed_position', `${expected.receipt_id}.receipt_type`);
  assert.strictEqual(receipt.verification_status, 'verified', `${expected.receipt_id}.verification_status`);
  assert.strictEqual(receipt.canonical_economics?.status, 'verified', `${expected.receipt_id}.canonical_economics.status`);
  assert.strictEqual(receipt.canonical_economics?.source, 'receipt_economics_v1', `${expected.receipt_id}.canonical_economics.source`);

  const fields = receipt.canonical_economics.fields;
  for (const field of [
    'hold_time_seconds',
    'realized_pnl_quote',
    'realized_pnl_pct',
    'avg_buy_quote_price',
    'avg_sell_quote_price',
    'total_sold_qty',
    'allocated_cost_basis_quote',
    'total_sold_quote',
    'accounting_method',
    'num_buys',
    'num_sells',
  ]) {
    assert.strictEqual(fields[field], expected[field], `${expected.receipt_id}.canonical_economics.fields.${field}`);
  }
}

function assertSafeModel(model, receipt, expected) {
  assert.strictEqual(model.identity.receipt_hash, expected.receipt_hash);
  assert.strictEqual(model.identity.receipt_id, expected.receipt_id);
  assert.strictEqual(model.identity.pair_display, `${expected.token_mint === PRODUCTION_SHARE_CARD_EXPECTATIONS.JUP.token_mint ? 'JUP' : 'RAY'}/${expected.quote_symbol}`);
  assert.strictEqual(model.hero.realized_pnl_quote.value, expected.realized_pnl_quote);
  assert.strictEqual(model.hero.realized_pnl_quote.quote_symbol, expected.quote_symbol);
  assert.strictEqual(model.hero.realized_pnl_pct.value, expected.realized_pnl_pct);
  assert.strictEqual(model.accounting_summary.accounting_method, expected.accounting_method);
  assert.strictEqual(model.accounting_summary.num_buys, expected.num_buys);
  assert.strictEqual(model.accounting_summary.num_sells, expected.num_sells);

  const serialized = JSON.stringify(model);
  assert.equal(serialized.includes(receipt.wallet), false, 'wallet leaked into Share Card model');
  for (const signature of [
    ...(receipt.canonical_economics.fields.entry_tx_hashes || []),
    ...(receipt.canonical_economics.fields.exit_tx_hashes || []),
  ]) {
    assert.equal(serialized.includes(signature), false, 'transaction signature leaked into Share Card model');
  }
}

export function runProductionShareCardCheck({
  engineRoot,
  archiveRoot,
  economicsRoot,
} = {}) {
  const resolvedEngineRoot = requireExplicitRoot(engineRoot, 'engine');
  const resolvedArchiveRoot = requireExplicitRoot(archiveRoot, 'archive');
  const resolvedEconomicsRoot = requireExplicitRoot(economicsRoot, 'economics');
  const snapshot = buildInventorySnapshot({
    engineRoot: resolvedEngineRoot,
    archiveRoot: resolvedArchiveRoot,
    economicsRoot: resolvedEconomicsRoot,
    includeArchive: true,
  });
  assert.deepStrictEqual(snapshot.archive.diagnostics, [], 'production inventory contains archive/economics diagnostics');

  const records = [];
  for (const [asset, expected] of Object.entries(PRODUCTION_SHARE_CARD_EXPECTATIONS)) {
    const matches = snapshot.receipts.filter(receipt => receipt.receipt_hash === expected.receipt_hash);
    assert.strictEqual(matches.length, 1, `expected exactly one production ${asset} receipt`);
    const receipt = matches[0];
    assertExactProductionReceipt(receipt, expected);

    const tokenDisplayMetadata = resolveTokenDisplayMetadata(receipt.token_mint);
    assert.strictEqual(tokenDisplayMetadata.display_kind, 'symbol', `${asset} token metadata display kind`);
    assert.strictEqual(tokenDisplayMetadata.symbol, asset, `${asset} token metadata symbol`);
    const beforeReceipt = structuredClone(receipt);
    const beforeMetadata = structuredClone(tokenDisplayMetadata);
    const links = {
      proof_href: `proof/${expected.receipt_hash}`,
      verifier_href: `verifier/${expected.receipt_hash}`,
    };
    const beforeLinks = structuredClone(links);
    const model = buildShareCardViewModel(receipt, { tokenDisplayMetadata, links });
    assert.deepStrictEqual(receipt, beforeReceipt, `${asset} inventory input was mutated`);
    assert.deepStrictEqual(tokenDisplayMetadata, beforeMetadata, `${asset} token metadata input was mutated`);
    assert.deepStrictEqual(links, beforeLinks, `${asset} link input was mutated`);
    assertSafeModel(model, receipt, expected);

    records.push(Object.freeze({
      asset,
      receipt_hash: expected.receipt_hash,
      receipt_id: expected.receipt_id,
      display_status: receipt.display_status,
      summary: expected.summary,
      model,
    }));
  }

  return Object.freeze({
    status: 'passed',
    records: Object.freeze(records),
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--engine-root') options.engineRoot = argv[++index];
    else if (arg === '--archive-root') options.archiveRoot = argv[++index];
    else if (arg === '--economics-root') options.economicsRoot = argv[++index];
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  return options;
}

export function main({ argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const result = runProductionShareCardCheck(parseArgs(argv));
    stdout.write('PASS production Share Card acceptance\n');
    for (const record of result.records) {
      stdout.write(`${record.asset} display_status: ${record.display_status}\n`);
      stdout.write(`${record.asset}: ${record.summary}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`FAIL production Share Card acceptance: ${error?.message || error}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = main();
}
