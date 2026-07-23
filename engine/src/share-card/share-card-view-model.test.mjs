import assert from 'assert';

import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import {
  buildShareCardViewModel,
  ShareCardEligibilityError,
} from './share-card-view-model.mjs';

const JUP_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const JUP_HASH = '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca';
const RAY_MINT = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const RAY_HASH = '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

// Validated production inventory projection containing every field Slice 1A reads,
// plus the sensitive source fields whose exclusion the tests prove.
function makeValidatedProductionJupInventoryFixture() {
  return {
    receipt_hash: JUP_HASH,
    receipt_id: 'art_v12_cp_JUPyiwrY_0',
    receipt_type: 'closed_position',
    wallet: '2ywe1NKkny7oUQM2yHRsnPYk2puQhWxWh3Gv98vhorni',
    token_mint: JUP_MINT,
    quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    quote_symbol: 'USDC',
    verification_status: 'verified',
    display_status: 'Verified Closed Position',
    first_event_at: 1781904268,
    last_event_at: 1782068814,
    canonical_economics: {
      status: 'verified',
      source: 'receipt_economics_v1',
      recovery_method: 'hash_matched_regeneration',
      fields: {
        segment_index: 0,
        entry_tx_hashes: ['2ArLuJC2JEuWiavk1jYxLQ2E4xhq63BbeDV2kCWPcZ9zZNc4XyugUEFEryKrYfqcWnxkUvyacRmj2YNTfZGq17yV'],
        exit_tx_hashes: ['5YCdUYkJVx3kkZUpvz4ygs6QT8GZtYtru4kGkur3LJ8yrMmW2XJ8qXtgjspMpJqqyQA6WPDQxd4BcTpNNSr3Dctk'],
        total_bought_qty: 265951.319268,
        total_bought_quote: 49728.694003,
        total_sold_qty: 265951.319268,
        total_sold_quote: 58016.53285,
        avg_buy_quote_price: 0.186984197483,
        avg_sell_quote_price: 0.21814718953,
        allocated_cost_basis_quote: 49728.694003,
        remaining_qty: 0,
        remaining_cost_basis_quote: 0,
        realized_pnl_quote: 8287.838847,
        realized_pnl_pct: 16.6661,
        accounting_method: 'weighted_average_position_accounting_v1',
        hold_time_seconds: 164546,
        num_buys: 1,
        num_sells: 1,
      },
    },
  };
}

function makeValidatedProductionRayInventoryFixture() {
  const receipt = makeValidatedProductionJupInventoryFixture();
  return {
    ...receipt,
    receipt_hash: RAY_HASH,
    receipt_id: 'art_v12_cp_4k3Dyjzv_0',
    wallet: '5fK3484fbh8gnmhvTsPYxTC6un7Co5LVUSoubZPVL3YA',
    token_mint: RAY_MINT,
    quote_mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    quote_symbol: 'USDT',
    first_event_at: 1769382291,
    last_event_at: 1769632666,
    canonical_economics: {
      ...receipt.canonical_economics,
      fields: {
        ...receipt.canonical_economics.fields,
        entry_tx_hashes: ['2SUoNBBTkQBBGVCinvLQbVZq5LDZS5M8ikx5PLH7QiCuLdf6GWCPSM7wLd6gJsNUbLSousAhbkSX9eXgt1dAeBKm'],
        exit_tx_hashes: ['4TmWRpMxWRTpQqNM7iFCRyP1m9VEyRK54VZwKeQV4cYisYRjQRjuvocF8j7mNAomoQf6H2h4vfd5Qp6Y2LQxeEsB'],
        total_bought_qty: 26644.791399,
        total_bought_quote: 25000,
        total_sold_qty: 26644.791399,
        total_sold_quote: 27347.717902,
        avg_buy_quote_price: 0.938269683768,
        avg_sell_quote_price: 1.02638138511,
        allocated_cost_basis_quote: 25000,
        realized_pnl_quote: 2347.717902,
        realized_pnl_pct: 9.39087,
        hold_time_seconds: 250375,
      },
    },
  };
}

function makeSyntheticReceipt() {
  const receipt = makeValidatedProductionJupInventoryFixture();
  receipt.wallet = 'SYNTHETIC_WALLET_NOT_A_PRODUCTION_RESULT';
  receipt.canonical_economics.fields.entry_tx_hashes = ['synthetic-entry-signature'];
  receipt.canonical_economics.fields.exit_tx_hashes = ['synthetic-exit-signature'];
  return receipt;
}

const LINKS = {
  proof_href: 'receipts/jup/proof.json',
  verifier_href: 'https://artifact.example/verifier/jup',
};

function build(receipt = makeSyntheticReceipt(), tokenDisplayMetadata = resolveTokenDisplayMetadata(receipt.token_mint), links = LINKS) {
  return buildShareCardViewModel(receipt, { tokenDisplayMetadata, links });
}

function expectEligibilityCode(code) {
  return error => error instanceof ShareCardEligibilityError && error.code === code;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

function visitKeys(value, visitor) {
  if (Array.isArray(value)) return value.forEach(child => visitKeys(child, visitor));
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    visitor(key, child);
    visitKeys(child, visitor);
  }
}

test('builds the exact validated production JUP Share Card view-model', () => {
  const card = buildShareCardViewModel(makeValidatedProductionJupInventoryFixture(), {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(JUP_MINT),
    links: LINKS,
  });

  assert.deepEqual(card, {
    share_card_version: 'share_card_v1',
    identity: {
      receipt_hash: JUP_HASH,
      receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
      receipt_id: 'art_v12_cp_JUPyiwrY_0',
      base_asset: {
        mint: JUP_MINT,
        display: 'JUP',
        display_kind: 'symbol',
        symbol: 'JUP',
        name: 'Jupiter',
      },
      quote_asset: {
        mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        symbol: 'USDC',
      },
      pair_display: 'JUP/USDC',
    },
    status: {
      position: 'closed',
      verification: 'verified',
      verification_label: 'Verified by Artifact',
    },
    hero: {
      realized_pnl_quote: {
        value: 8287.838847,
        quote_symbol: 'USDC',
        direction: 'positive',
      },
      realized_pnl_pct: {
        value: 16.6661,
        direction: 'positive',
      },
    },
    trade_summary: {
      avg_entry_quote_price: 0.186984197483,
      avg_exit_quote_price: 0.21814718953,
      opened_at: 1781904268,
      closed_at: 1782068814,
      hold_time_seconds: 164546,
    },
    accounting_summary: {
      quantity_closed: 265951.319268,
      entry_cost_quote: 49728.694003,
      exit_proceeds_quote: 58016.53285,
      accounting_method: 'weighted_average_position_accounting_v1',
      num_buys: 1,
      num_sells: 1,
    },
    proof: {
      receipt_id: 'art_v12_cp_JUPyiwrY_0',
      receipt_hash: JUP_HASH,
      receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
      quote_scope: 'raw_quote',
      receipt_scope: 'receipt_only',
    },
    badges: ['Closed Position', 'Verified', 'Raw Quote', 'Receipt Scoped'],
    disclosure: 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.',
    links: LINKS,
  });
});

test('builds the exact validated production RAY summary from canonical raw-quote values', () => {
  const card = build(makeValidatedProductionRayInventoryFixture());
  assert.deepEqual(card.identity.base_asset, {
    mint: RAY_MINT,
    display: 'RAY',
    display_kind: 'symbol',
    symbol: 'RAY',
    name: 'Raydium',
  });
  assert.deepEqual(card.identity.quote_asset, {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    symbol: 'USDT',
  });
  assert.equal(card.identity.pair_display, 'RAY/USDT');
  assert.equal(card.hero.realized_pnl_quote.value, 2347.717902);
  assert.equal(card.hero.realized_pnl_pct.value, 9.39087);
  assert.equal(card.trade_summary.avg_entry_quote_price, 0.938269683768);
  assert.equal(card.trade_summary.avg_exit_quote_price, 1.02638138511);
  assert.equal(card.accounting_summary.quantity_closed, 26644.791399);
  assert.equal(card.accounting_summary.entry_cost_quote, 25000);
  assert.equal(card.accounting_summary.exit_proceeds_quote, 27347.717902);
});

test('derives positive, negative, and exactly flat directions only by comparison with zero', () => {
  assert.equal(build().hero.realized_pnl_quote.direction, 'positive');

  const negative = makeSyntheticReceipt();
  negative.canonical_economics.fields.realized_pnl_quote = -0.0000001;
  negative.canonical_economics.fields.realized_pnl_pct = -0.0002;
  assert.deepEqual(build(negative).hero, {
    realized_pnl_quote: { value: -0.0000001, quote_symbol: 'USDC', direction: 'negative' },
    realized_pnl_pct: { value: -0.0002, direction: 'negative' },
  });

  const flat = makeSyntheticReceipt();
  flat.canonical_economics.fields.realized_pnl_quote = 0;
  flat.canonical_economics.fields.realized_pnl_pct = -0;
  assert.equal(build(flat).hero.realized_pnl_quote.direction, 'flat');
  assert.equal(build(flat).hero.realized_pnl_pct.direction, 'flat');
});

test('mint-prefix metadata is display-only and never becomes a symbol or inferred name', () => {
  const receipt = makeSyntheticReceipt();
  receipt.token_mint = 'So11111111111111111111111111111111111111112';
  const metadata = {
    mint: receipt.token_mint,
    display: 'So111111...',
    display_kind: 'mint_prefix',
    symbol: 'FAKE',
    name: 'Fabricated',
  };
  const card = build(receipt, metadata);
  assert.deepEqual(card.identity.base_asset, {
    mint: receipt.token_mint,
    display: 'So111111...',
    display_kind: 'mint_prefix',
  });
  assert.equal(card.identity.pair_display, 'So111111.../USDC');
});

test('serialized output leaks no wallet identity or forbidden receipt internals', () => {
  const receipt = makeValidatedProductionJupInventoryFixture();
  receipt.profile = { handle: 'forbidden-profile' };
  receipt.portfolio = { rank: 1 };
  receipt.track_record = { win_rate: 1 };
  receipt.provider = 'forbidden-provider';
  receipt.evidence_path = '/root/private/evidence.json';
  receipt.raw_transaction = { body: 'forbidden-raw-body' };
  receipt.usd_value = 12345;
  receipt.upload_status = 'forbidden-upload';
  receipt.mint_status = 'forbidden-mint';
  receipt.signing_status = 'forbidden-signing';
  const serialized = JSON.stringify(build(receipt));
  assert.ok(!serialized.includes(receipt.wallet));
  assert.ok(!serialized.includes(receipt.canonical_economics.fields.entry_tx_hashes[0]));
  assert.ok(!serialized.includes(receipt.canonical_economics.fields.exit_tx_hashes[0]));
  assert.ok(!serialized.includes('hash_matched_regeneration'));
  assert.ok(!serialized.includes('forbidden-'));
  assert.ok(!serialized.includes('/root/private'));
  assert.ok(!serialized.includes('usd_value'));
  assert.ok(!serialized.includes('entry_tx_hashes'));
  assert.ok(!serialized.includes('exit_tx_hashes'));
  assert.ok(!serialized.includes('recovery_method'));
  assert.ok(!serialized.includes('project_review'));
  const forbiddenKeys = new Set([
    'wallet',
    'profile',
    'portfolio',
    'rank',
    'track_record',
    'provider',
    'raw_transaction',
    'usd_value',
    'upload_status',
    'mint_status',
    'signing_status',
  ]);
  visitKeys(build(receipt), key => assert.ok(!forbiddenKeys.has(key), key));
});

test('missing, unverified, or wrong-source canonical economics fail closed', () => {
  const missing = makeSyntheticReceipt();
  delete missing.canonical_economics;
  assert.throws(() => build(missing), expectEligibilityCode('canonical_economics_not_verified'));

  const unverified = makeSyntheticReceipt();
  unverified.canonical_economics.status = 'unverified';
  assert.throws(() => build(unverified), expectEligibilityCode('canonical_economics_not_verified'));

  const wrongSource = makeSyntheticReceipt();
  wrongSource.canonical_economics.source = 'runtime_recovery';
  assert.throws(() => build(wrongSource), expectEligibilityCode('canonical_economics_not_verified'));
});

test('open or partial receipts fail closed', () => {
  for (const receiptType of ['open_snapshot', 'partial_position']) {
    const receipt = makeSyntheticReceipt();
    receipt.receipt_type = receiptType;
    assert.throws(() => build(receipt), expectEligibilityCode('receipt_type_not_eligible'));
  }
});

test('unverified receipt or ineligible display status fails closed', () => {
  const unverified = makeSyntheticReceipt();
  unverified.verification_status = 'unverified';
  assert.throws(() => build(unverified), expectEligibilityCode('receipt_not_verified'));

  const wrongDisplay = makeSyntheticReceipt();
  wrongDisplay.display_status = 'Verified Snapshot (No PnL Claim)';
  assert.throws(() => build(wrongDisplay), expectEligibilityCode('receipt_not_verified'));
});

test('token metadata must exactly match the full receipt mint', () => {
  assert.throws(
    () => build(makeSyntheticReceipt(), resolveTokenDisplayMetadata(RAY_MINT)),
    expectEligibilityCode('token_metadata_mismatch'),
  );
});

test('unsafe or malformed proof links fail with invalid_proof_link', () => {
  const invalid = [
    '',
    '#proof',
    'javascript:alert(1)',
    '%6aavascript%3aalert(1)',
    'data:text/plain,proof',
    'data%3atext/plain,proof',
    'file:///tmp/proof.json',
    'file%3a///tmp/proof.json',
    'https:artifact.example/proof',
    'https://user:pass@example.com/proof',
    'proof folder/proof.json',
    'C:\\Users\\operator\\proof.json',
    '\\\\server\\share\\proof.json',
    '/root/private/proof.json',
    '/proc/self/environ',
    '/dev/null',
    '/sys/kernel',
    '/usr/local/secret',
    '/opt/private',
    '/run/secrets/proof',
    '/mnt/private/proof',
    '/private/etc/proof',
    '/C:/Users/operator/proof.json',
    '/ro%6ft/private/proof.json',
    '/Us%65rs/operator/proof.json',
    '/./root/private/proof.json',
    '/.//root/private/proof.json',
    '/../root/private/proof.json',
    '/root?download=1',
    '../../etc/passwd',
    '../C:/Users/operator/proof.json',
    '%43%3a/Users/operator/proof.json',
    'C%3a/Users/operator/proof.json',
    '%2543%253a/Users/operator/proof.json',
    '//evil.example/proof',
    'safe/%2e%2e/private/proof.json',
    'safe/%2E./private/proof.json',
    'safe/.%2e/private/proof.json',
    'safe/%2fprivate/proof.json',
    'safe/%5cprivate/proof.json',
    'safe/%252e%252e/private/proof.json',
    'https://artifact.example/safe/../private/proof.json',
  ];
  for (const proof_href of invalid) {
    assert.throws(
      () => build(makeSyntheticReceipt(), resolveTokenDisplayMetadata(JUP_MINT), { ...LINKS, proof_href }),
      expectEligibilityCode('invalid_proof_link'),
      proof_href,
    );
  }
});

test('unsafe or malformed verifier links fail with invalid_verifier_link', () => {
  for (const verifier_href of ['', '#verify', 'http://artifact.example/verify', 'file:///verify', '../private/../verify']) {
    assert.throws(
      () => build(makeSyntheticReceipt(), resolveTokenDisplayMetadata(JUP_MINT), { ...LINKS, verifier_href }),
      expectEligibilityCode('invalid_verifier_link'),
      verifier_href,
    );
  }
});

test('explicit relative, root-relative, and credential-free HTTPS links are retained exactly', () => {
  const accepted = [
    { proof_href: './receipts/jup/proof.json', verifier_href: '../verifier/jup.json' },
    { proof_href: '/proof/jup', verifier_href: '/verifier/jup?mode=compact' },
    { proof_href: 'https://artifact.example/proof/jup#receipt', verifier_href: 'https://artifact.example/verify/jup' },
  ];
  for (const links of accepted) assert.deepEqual(build(makeSyntheticReceipt(), resolveTokenDisplayMetadata(JUP_MINT), links).links, links);
});

test('canonical raw-quote numbers are copied exactly without formatting, rounding, or recomputation', () => {
  const receipt = makeSyntheticReceipt();
  const fields = receipt.canonical_economics.fields;
  fields.realized_pnl_quote = 0.123456789012345;
  fields.realized_pnl_pct = -0.000000000123;
  fields.avg_buy_quote_price = 1.23456789012345e-9;
  fields.avg_sell_quote_price = 987654321.1234567;
  fields.total_sold_qty = 123456789.0000001;
  fields.allocated_cost_basis_quote = 999.999999999999;
  fields.total_sold_quote = 1000.000000000001;
  const card = build(receipt);
  assert.strictEqual(card.hero.realized_pnl_quote.value, fields.realized_pnl_quote);
  assert.strictEqual(card.hero.realized_pnl_pct.value, fields.realized_pnl_pct);
  assert.strictEqual(card.trade_summary.avg_entry_quote_price, fields.avg_buy_quote_price);
  assert.strictEqual(card.trade_summary.avg_exit_quote_price, fields.avg_sell_quote_price);
  assert.strictEqual(card.accounting_summary.quantity_closed, fields.total_sold_qty);
  assert.strictEqual(card.accounting_summary.entry_cost_quote, fields.allocated_cost_basis_quote);
  assert.strictEqual(card.accounting_summary.exit_proceeds_quote, fields.total_sold_quote);
});

test('missing canonical values fail instead of producing null, N/A, or fabricated placeholders', () => {
  const receipt = makeSyntheticReceipt();
  delete receipt.canonical_economics.fields.avg_buy_quote_price;
  assert.throws(() => build(receipt), expectEligibilityCode('invalid_canonical_economics'));
});

test('inputs remain unmodified and output is deeply immutable', () => {
  const receipt = makeSyntheticReceipt();
  const metadata = resolveTokenDisplayMetadata(JUP_MINT);
  const links = structuredClone(LINKS);
  const beforeReceipt = structuredClone(receipt);
  const beforeMetadata = structuredClone(metadata);
  const beforeLinks = structuredClone(links);
  const card = build(receipt, metadata, links);
  assert.deepEqual(receipt, beforeReceipt);
  assert.deepEqual(metadata, beforeMetadata);
  assert.deepEqual(links, beforeLinks);
  assert.throws(() => { card.identity.base_asset.display = 'MUTATED'; }, TypeError);
  assert.throws(() => { card.badges.push('MUTATED'); }, TypeError);
});

test('serialization is deterministic and independent of input object insertion order', () => {
  const receipt = makeSyntheticReceipt();
  const metadata = resolveTokenDisplayMetadata(JUP_MINT);
  assert.equal(
    JSON.stringify(build(receipt, metadata, LINKS)),
    JSON.stringify(build(reverseKeys(receipt), reverseKeys(metadata), reverseKeys(LINKS))),
  );
});

test('exact disclosure and badge order are stable and no output value is null or N/A', () => {
  const card = build();
  assert.deepEqual(card.badges, ['Closed Position', 'Verified', 'Raw Quote', 'Receipt Scoped']);
  assert.equal(card.disclosure, 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.');
  visitKeys(card, (key, value) => {
    assert.notEqual(value, null, key);
    assert.notEqual(value, 'N/A', key);
  });
});

test('walletDisplayMode is not an accepted Share Card option', () => {
  assert.throws(
    () => buildShareCardViewModel(makeSyntheticReceipt(), {
      tokenDisplayMetadata: resolveTokenDisplayMetadata(JUP_MINT),
      links: LINKS,
      walletDisplayMode: 'redacted',
    }),
    expectEligibilityCode('invalid_options'),
  );
});

console.log(`\n${passed}/${passed + failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
