import assert from 'assert';
import { readFileSync } from 'fs';

import {
  formatShareCardViewModel,
  ShareCardFormatError,
} from './share-card-format.mjs';

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

function makeCard(overrides = {}) {
  const card = {
    share_card_version: 'share_card_v1',
    identity: {
      receipt_hash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
      receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
      receipt_id: 'art_v12_cp_JUPyiwrY_0',
      base_asset: {
        mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
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
      realized_pnl_quote: { value: 8287.838847, quote_symbol: 'USDC', direction: 'positive' },
      realized_pnl_pct: { value: 16.6661, direction: 'positive' },
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
      receipt_hash: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
      receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
      quote_scope: 'raw_quote',
      receipt_scope: 'receipt_only',
    },
    badges: ['Closed Position', 'Verified', 'Raw Quote', 'Receipt Scoped'],
    disclosure: 'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.',
    links: {
      proof_href: 'proof/5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
      verifier_href: 'verifier/5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
    },
  };
  return Object.assign(card, overrides);
}

function makeRayCard() {
  const card = makeCard();
  Object.assign(card.identity, {
    receipt_hash: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
    receipt_hash_short: '4d33969c45a0...84d4570e4341',
    receipt_id: 'art_v12_cp_4k3Dyjzv_0',
    base_asset: {
      mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
      display: 'RAY',
      display_kind: 'symbol',
      symbol: 'RAY',
      name: 'Raydium',
    },
    quote_asset: {
      mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      symbol: 'USDT',
    },
    pair_display: 'RAY/USDT',
  });
  card.hero = {
    realized_pnl_quote: { value: 2347.717902, quote_symbol: 'USDT', direction: 'positive' },
    realized_pnl_pct: { value: 9.39087, direction: 'positive' },
  };
  card.trade_summary = {
    avg_entry_quote_price: 0.938269683768,
    avg_exit_quote_price: 1.02638138511,
    opened_at: 1769382291,
    closed_at: 1769632666,
    hold_time_seconds: 250375,
  };
  card.accounting_summary = {
    quantity_closed: 26644.791399,
    entry_cost_quote: 25000,
    exit_proceeds_quote: 27347.717902,
    accounting_method: 'weighted_average_position_accounting_v1',
    num_buys: 1,
    num_sells: 1,
  };
  card.proof = {
    ...card.proof,
    receipt_id: card.identity.receipt_id,
    receipt_hash: card.identity.receipt_hash,
    receipt_hash_short: card.identity.receipt_hash_short,
  };
  return card;
}

function expectFormatCode(code) {
  return error => error instanceof ShareCardFormatError && error.code === code;
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

test('formats the exact production JUP display strings', () => {
  const source = makeCard();
  const before = structuredClone(source);
  const formatted = formatShareCardViewModel(source);

  assert.deepEqual(formatted.display, {
    pair: 'JUP/USDC',
    realized_pnl_quote: '+8,287.84 USDC',
    realized_pnl_pct: '+16.67%',
    avg_entry_quote_price: '0.186984 USDC',
    avg_exit_quote_price: '0.218147 USDC',
    quantity_closed: '265,951.319268 JUP',
    entry_cost_quote: '49,728.69 USDC',
    exit_proceeds_quote: '58,016.53 USDC',
    opened_at: '2026-06-19 21:24 UTC',
    closed_at: '2026-06-21 19:06 UTC',
    duration: '1d 21h 42m 26s',
    receipt_hash_short: '5fb5732d248a...5ddf02a0bbca',
  });
  assert.deepEqual(formatted.formatting, {
    number_format_version: 'artifact_number_v1',
    date_format_version: 'artifact_utc_date_v1',
  });
  assert.deepEqual(source, before);
  assert.strictEqual(formatted.hero.realized_pnl_quote.value, source.hero.realized_pnl_quote.value);
  assert.strictEqual(formatted.trade_summary.avg_entry_quote_price, source.trade_summary.avg_entry_quote_price);
  assert.throws(() => { formatted.display.pair = 'MUTATED'; }, TypeError);
  assert.throws(() => { formatted.badges.push('MUTATED'); }, TypeError);
});

test('formats the exact production RAY display strings', () => {
  assert.deepEqual(formatShareCardViewModel(makeRayCard()).display, {
    pair: 'RAY/USDT',
    realized_pnl_quote: '+2,347.72 USDT',
    realized_pnl_pct: '+9.39%',
    avg_entry_quote_price: '0.93827 USDT',
    avg_exit_quote_price: '1.0264 USDT',
    quantity_closed: '26,644.791399 RAY',
    entry_cost_quote: '25,000.00 USDT',
    exit_proceeds_quote: '27,347.72 USDT',
    opened_at: '2026-01-25 23:04 UTC',
    closed_at: '2026-01-28 20:37 UTC',
    duration: '2d 21h 32m 55s',
    receipt_hash_short: '4d33969c45a0...84d4570e4341',
  });
});

test('formats negative, flat, and negative-zero PnL without locale-dependent signs', () => {
  const negative = makeCard();
  negative.hero.realized_pnl_quote.value = -125.4;
  negative.hero.realized_pnl_quote.direction = 'negative';
  negative.hero.realized_pnl_pct.value = -4.25;
  negative.hero.realized_pnl_pct.direction = 'negative';
  assert.equal(formatShareCardViewModel(negative).display.realized_pnl_quote, '-125.40 USDC');
  assert.equal(formatShareCardViewModel(negative).display.realized_pnl_pct, '-4.25%');

  const flat = makeCard();
  flat.hero.realized_pnl_quote.value = -0;
  flat.hero.realized_pnl_quote.direction = 'flat';
  flat.hero.realized_pnl_pct.value = 0;
  flat.hero.realized_pnl_pct.direction = 'flat';
  assert.equal(formatShareCardViewModel(flat).display.realized_pnl_quote, '0.00 USDC');
  assert.equal(formatShareCardViewModel(flat).display.realized_pnl_pct, '0.00%');
  assert.ok(Object.is(formatShareCardViewModel(flat).hero.realized_pnl_quote.value, -0));
});

test('uses tiered price precision and never renders a representable nonzero price as zero', () => {
  const card = makeCard();
  card.trade_summary.avg_entry_quote_price = 12.34;
  card.trade_summary.avg_exit_quote_price = 1234.5;
  let display = formatShareCardViewModel(card).display;
  assert.equal(display.avg_entry_quote_price, '12.34 USDC');
  assert.equal(display.avg_exit_quote_price, '1,234.5 USDC');

  card.trade_summary.avg_entry_quote_price = 0.00000001;
  card.trade_summary.avg_exit_quote_price = 0.000000000001;
  display = formatShareCardViewModel(card).display;
  assert.equal(display.avg_entry_quote_price, '0.00000001 USDC');
  assert.equal(display.avg_exit_quote_price, '0.000000000001 USDC');

  card.trade_summary.avg_entry_quote_price = 0.0000000000001;
  assert.throws(() => formatShareCardViewModel(card), expectFormatCode('invalid_numeric_value'));
});

test('large values use comma grouping and never scientific notation', () => {
  const card = makeCard();
  card.trade_summary.avg_entry_quote_price = 1e25;
  card.accounting_summary.quantity_closed = 1e25;
  card.accounting_summary.entry_cost_quote = 1e25;
  const display = formatShareCardViewModel(card).display;
  assert.equal(display.avg_entry_quote_price, '10,000,000,000,000,000,000,000,000 USDC');
  assert.equal(display.quantity_closed, '10,000,000,000,000,000,000,000,000 JUP');
  assert.equal(display.entry_cost_quote, '10,000,000,000,000,000,000,000,000.00 USDC');
  assert.equal(/[eE]/.test(`${display.avg_entry_quote_price}${display.quantity_closed}${display.entry_cost_quote}`), false);
});

test('formats compact durations with stable subordinate padding', () => {
  const cases = [
    [26, '26s'],
    [725, '12m 05s'],
    [11049, '3h 04m 09s'],
    [164546, '1d 21h 42m 26s'],
  ];
  for (const [holdTime, expected] of cases) {
    const card = makeCard();
    card.trade_summary.hold_time_seconds = holdTime;
    assert.equal(formatShareCardViewModel(card).display.duration, expected);
  }
});

test('UTC timestamp output is identical under different TZ environment values', () => {
  const originalTz = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const honolulu = formatShareCardViewModel(makeCard()).display;
    process.env.TZ = 'Asia/Tokyo';
    const tokyo = formatShareCardViewModel(makeCard()).display;
    assert.equal(honolulu.opened_at, '2026-06-19 21:24 UTC');
    assert.equal(honolulu.closed_at, '2026-06-21 19:06 UTC');
    assert.equal(tokyo.opened_at, honolulu.opened_at);
    assert.equal(tokyo.closed_at, honolulu.closed_at);
  } finally {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  }
});

test('invalid, fractional, unsafe, and out-of-range timestamps fail closed', () => {
  for (const timestamp of [NaN, 1.5, Number.MAX_SAFE_INTEGER + 1, 8640000000001]) {
    const card = makeCard();
    card.trade_summary.opened_at = timestamp;
    assert.throws(() => formatShareCardViewModel(card), expectFormatCode('invalid_timestamp'), String(timestamp));
  }
});

test('negative, fractional, and unsafe durations fail closed', () => {
  for (const duration of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const card = makeCard();
    card.trade_summary.hold_time_seconds = duration;
    assert.throws(() => formatShareCardViewModel(card), expectFormatCode('invalid_duration'), String(duration));
  }
});

test('unknown mint-prefix asset uses its display value without inventing a symbol', () => {
  const card = makeCard();
  card.identity.base_asset = {
    mint: 'So11111111111111111111111111111111111111112',
    display: 'So111111...',
    display_kind: 'mint_prefix',
  };
  card.identity.pair_display = 'So111111.../USDC';
  const formatted = formatShareCardViewModel(card);
  assert.equal(formatted.display.pair, 'So111111.../USDC');
  assert.equal(formatted.display.quantity_closed, '265,951.319268 So111111...');
  assert.equal(Object.hasOwn(formatted.identity.base_asset, 'symbol'), false);
});

test('canonical raw values are deeply cloned without rounding or recomputation', () => {
  const card = makeCard();
  card.hero.realized_pnl_quote.value = 0.123456789012345;
  card.hero.realized_pnl_pct.value = -0.000000000123;
  card.hero.realized_pnl_pct.direction = 'negative';
  card.trade_summary.avg_entry_quote_price = 1.23456789012345e-9;
  card.trade_summary.avg_exit_quote_price = 987654321.1234567;
  card.accounting_summary.quantity_closed = 123456789.0000001;
  card.accounting_summary.entry_cost_quote = 999.999999999999;
  card.accounting_summary.exit_proceeds_quote = 1000.000000000001;
  const before = structuredClone(card);
  const formatted = formatShareCardViewModel(card);
  assert.deepEqual(card, before);
  assert.strictEqual(formatted.hero.realized_pnl_quote.value, card.hero.realized_pnl_quote.value);
  assert.strictEqual(formatted.hero.realized_pnl_pct.value, card.hero.realized_pnl_pct.value);
  assert.strictEqual(formatted.trade_summary.avg_entry_quote_price, card.trade_summary.avg_entry_quote_price);
  assert.strictEqual(formatted.trade_summary.avg_exit_quote_price, card.trade_summary.avg_exit_quote_price);
  assert.strictEqual(formatted.accounting_summary.quantity_closed, card.accounting_summary.quantity_closed);
  assert.strictEqual(formatted.accounting_summary.entry_cost_quote, card.accounting_summary.entry_cost_quote);
  assert.strictEqual(formatted.accounting_summary.exit_proceeds_quote, card.accounting_summary.exit_proceeds_quote);
});

test('format versions and malformed models use stable ShareCardFormatError codes', () => {
  assert.throws(
    () => formatShareCardViewModel(makeCard(), { number_format_version: 'host_locale' }),
    expectFormatCode('unsupported_number_format_version'),
  );
  assert.throws(
    () => formatShareCardViewModel(makeCard(), { date_format_version: 'local_date' }),
    expectFormatCode('unsupported_date_format_version'),
  );
  assert.throws(
    () => formatShareCardViewModel({ ...makeCard(), share_card_version: 'share_card_v2' }),
    expectFormatCode('invalid_share_card_model'),
  );
  const invalidNumber = makeCard();
  invalidNumber.accounting_summary.quantity_closed = Infinity;
  assert.throws(() => formatShareCardViewModel(invalidNumber), expectFormatCode('invalid_numeric_value'));
  const invalidAsset = makeCard();
  invalidAsset.identity.base_asset.display_kind = 'inferred_symbol';
  assert.throws(() => formatShareCardViewModel(invalidAsset), expectFormatCode('invalid_asset_display'));
});

test('malformed or forbidden fields cannot cross the formatting boundary', () => {
  const forbidden = makeCard();
  forbidden.wallet = 'FORBIDDEN_WALLET';
  assert.throws(() => formatShareCardViewModel(forbidden), expectFormatCode('invalid_share_card_model'));

  const wrongHashShort = makeCard();
  wrongHashShort.identity.receipt_hash_short = 'wrong';
  assert.throws(() => formatShareCardViewModel(wrongHashShort), expectFormatCode('invalid_share_card_model'));

  const wrongScope = makeCard();
  wrongScope.proof.quote_scope = 'wallet_aggregate';
  assert.throws(() => formatShareCardViewModel(wrongScope), expectFormatCode('invalid_share_card_model'));

  const unsafeLink = makeCard();
  unsafeLink.links.proof_href = 'javascript:alert(1)';
  assert.throws(() => formatShareCardViewModel(unsafeLink), expectFormatCode('invalid_share_card_model'));
});

test('serialization is deterministic across input key ordering and output is deeply immutable', () => {
  const card = makeCard();
  const normal = formatShareCardViewModel(card);
  const reversed = formatShareCardViewModel(reverseKeys(card));
  assert.equal(JSON.stringify(normal), JSON.stringify(reversed));
  assert.notStrictEqual(normal.identity, card.identity);
  assert.notStrictEqual(normal.badges, card.badges);
  assert.throws(() => { normal.identity.base_asset.display = 'MUTATED'; }, TypeError);
  assert.throws(() => { normal.links.proof_href = 'MUTATED'; }, TypeError);
});

test('formatter source contains no locale-sensitive number or date APIs', () => {
  const source = readFileSync(new URL('./share-card-format.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes('Intl.'), false);
  assert.equal(source.includes('toLocaleString'), false);
  assert.equal(source.includes('toLocaleDateString'), false);
  assert.equal(source.includes('toLocaleTimeString'), false);
});

console.log(`\nShare Card formatter tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
