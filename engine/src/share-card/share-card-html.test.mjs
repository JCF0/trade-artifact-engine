import assert from 'assert';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

import { formatShareCardViewModel } from './share-card-format.mjs';
import {
  renderShareCardHtml,
  ShareCardHtmlError,
} from './share-card-html.mjs';

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

function makeRawCard() {
  return {
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
}

function makeFormattedCard() {
  return formatShareCardViewModel(makeRawCard());
}

function makeRayFormattedCard() {
  const card = makeRawCard();
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
  card.links = {
    proof_href: `proof/${card.identity.receipt_hash}`,
    verifier_href: `verifier/${card.identity.receipt_hash}`,
  };
  return formatShareCardViewModel(card);
}

function mutableClone(value) {
  return structuredClone(value);
}

function reverseKeys(value) {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)]));
}

function expectHtmlCode(code) {
  return error => error instanceof ShareCardHtmlError && error.code === code;
}

function render(card = makeFormattedCard(), logoHref = '/assets/artifact-logo-header.png') {
  return renderShareCardHtml(card, { logo_href: logoHref });
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const REQUIRED_JUP_STRINGS = Object.freeze([
  'JUP/USDC',
  '+8,287.84 USDC',
  '+16.67%',
  '0.186984 USDC',
  '0.218147 USDC',
  '2026-06-19 21:24 UTC',
  '2026-06-21 19:06 UTC',
  '1d 21h 42m 26s',
  '265,951.319268 JUP',
  '49,728.69 USDC',
  '58,016.53 USDC',
  'art_v12_cp_JUPyiwrY_0',
  '5fb5732d248a...5ddf02a0bbca',
]);

const REQUIRED_RAY_STRINGS = Object.freeze([
  'RAY/USDT',
  '+2,347.72 USDT',
  '+9.39%',
  '0.93827 USDT',
  '1.0264 USDT',
  '2026-01-25 23:04 UTC',
  '2026-01-28 20:37 UTC',
  '2d 21h 32m 55s',
  '26,644.791399 RAY',
  '25,000.00 USDT',
  '27,347.72 USDT',
  'art_v12_cp_4k3Dyjzv_0',
  '4d33969c45a0...84d4570e4341',
]);

test('renders exact deterministic production JUP and RAY documents', () => {
  const jup = render(makeFormattedCard());
  const ray = render(makeRayFormattedCard());
  for (const expected of REQUIRED_JUP_STRINGS) assert.ok(jup.includes(expected), expected);
  for (const expected of REQUIRED_RAY_STRINGS) assert.ok(ray.includes(expected), expected);
  assert.equal(sha256(jup), '36a7d18426aaeb67290932eb2d70439bb4812f0245cb5d038150b0d7f2455027');
  assert.equal(sha256(ray), 'ded1a0e200213e11aa761272535f23050ea40c7f0023b85cc34e226efdcf40c8');
});

test('renders a standalone LF-terminated UTF-8 HTML document with one exact desktop card root', () => {
  const html = render();
  assert.ok(html.startsWith('<!doctype html>\n'));
  assert.ok(html.includes('<meta charset="utf-8">'));
  assert.ok(html.includes('<meta name="robots" content="noindex,nofollow">'));
  assert.ok(html.endsWith('\n'));
  assert.equal(html.includes('\r'), false);
  assert.equal((html.match(/data-share-card-version="share_card_v1"/g) || []).length, 1);
  assert.match(html, /data-share-card-version="share_card_v1"[^>]*>/);
  assert.ok(html.includes('width: 1200px;'));
  assert.ok(html.includes('height: 630px;'));
  assert.ok(html.includes('aspect-ratio: 1200 / 630;'));
  assert.ok(html.includes('src="/assets/artifact-logo-header.png"'));
});

test('reflows below the mobile breakpoint without scaling the desktop composition', () => {
  const html = render();
  assert.ok(html.includes('@media (max-width: 800px)'));
  assert.ok(html.includes('width: 100%;'));
  assert.ok(html.includes('height: auto;'));
  assert.ok(html.includes('aspect-ratio: auto;'));
  assert.ok(html.includes('overflow-x: hidden;'));
  assert.ok(html.includes('grid-template-columns: 1fr;'));
  assert.ok(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr));'));
  assert.ok(html.includes('transform: none;'));
  assert.ok(html.includes('@media (min-width: 801px) and (max-width: 1199px)'));
});

test('uses positive, negative, and flat hero classes without changing verification green', () => {
  for (const direction of ['positive', 'negative', 'flat']) {
    const card = mutableClone(makeFormattedCard());
    const value = direction === 'positive' ? 1 : direction === 'negative' ? -1 : 0;
    card.hero.realized_pnl_quote.value = value;
    card.hero.realized_pnl_pct.value = value;
    card.hero.realized_pnl_quote.direction = direction;
    card.hero.realized_pnl_pct.direction = direction;
    const html = render(card);
    assert.ok(html.includes(`hero--${direction}`));
    assert.ok(html.includes('verification-badge'));
    assert.ok(html.includes('--verified: #16803c;'));
  }
  const negative = mutableClone(makeFormattedCard());
  negative.hero.realized_pnl_quote.value = -125.4;
  negative.hero.realized_pnl_pct.value = -4.25;
  negative.hero.realized_pnl_quote.direction = 'negative';
  negative.hero.realized_pnl_pct.direction = 'negative';
  negative.display.realized_pnl_quote = '-125.40 USDC';
  negative.display.realized_pnl_pct = '-4.25%';
  const html = render(negative);
  assert.ok(html.includes('hero--negative'));
  assert.ok(html.includes('Verified by Artifact'));
  assert.equal(html.includes('Unverified'), false);
  assert.equal(html.includes('Failed'), false);
});

test('supports independently validated quote and percentage directions', () => {
  const card = mutableClone(makeFormattedCard());
  card.hero.realized_pnl_pct.value = -4.25;
  card.hero.realized_pnl_pct.direction = 'negative';
  card.display.realized_pnl_pct = '-4.25%';
  const html = render(card);
  assert.ok(html.includes('hero--positive'));
  assert.ok(html.includes('hero-percent pnl--negative'));
});

test('contains required headings, labelled statistics, proof actions, and exact disclosure', () => {
  const html = render();
  for (const text of [
    'Artifact', 'Closed Position', 'Verified by Artifact', 'Raw Quote',
    'Average Entry', 'Average Exit', 'Opened', 'Closed', 'Duration',
    'Quantity Closed', 'Entry Cost', 'Exit Proceeds', 'Receipt ID', 'Receipt Hash',
    'Receipt Scoped', 'View Proof', 'Verify Receipt',
    'Receipt-scoped only. Raw quote only. Not wallet or portfolio performance.',
  ]) assert.ok(html.includes(text), text);
  assert.ok(html.includes('<h1'));
  assert.ok(html.includes('<h2'));
  assert.ok(html.includes('<dl'));
});

test('uses accessible logo and descriptive proof link labels', () => {
  const html = render();
  assert.ok(html.includes('alt="Artifact logo"'));
  assert.ok(html.includes('aria-label="View proof for receipt art_v12_cp_JUPyiwrY_0"'));
  assert.ok(html.includes('aria-label="Verify receipt art_v12_cp_JUPyiwrY_0"'));
});

test('escapes dynamic text and attribute values without allowing markup injection', () => {
  const card = mutableClone(makeFormattedCard());
  card.identity.receipt_id = 'receipt &quot;\"><script>alert(1)</script> & Ω';
  card.proof.receipt_id = card.identity.receipt_id;
  card.display.pair = 'A&B <C> "D" Ω/USDC';
  card.identity.base_asset.display = 'A&B <C> "D" Ω';
  card.identity.base_asset.symbol = card.identity.base_asset.display;
  card.identity.pair_display = card.display.pair;
  card.links.proof_href = 'proof/a?next=%22%3E%3Csvg%20onload%3Dalert(1)%3E&amp=1';
  card.links.verifier_href = 'https://example.test/verify?a=1&b=%22quoted%22';
  const html = render(card, '/assets/logo & "mark".svg');
  assert.ok(html.includes('A&amp;B &lt;C&gt; &quot;D&quot; Ω/USDC'));
  assert.ok(html.includes('receipt &amp;quot;&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; Ω'));
  assert.ok(html.includes('src="/assets/logo &amp; &quot;mark&quot;.svg"'));
  assert.ok(html.includes('href="proof/a?next=%22%3E%3Csvg%20onload%3Dalert(1)%3E&amp;amp=1"'));
  assert.ok(html.includes('href="https://example.test/verify?a=1&amp;b=%22quoted%22" rel="noopener noreferrer"'));
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
});

test('rejects unsafe logo paths with invalid_logo_link', () => {
  assert.throws(
    () => renderShareCardHtml(makeFormattedCard(), {}),
    expectHtmlCode('invalid_logo_link'),
  );
  for (const logoHref of [
    '', '#logo', '?logo=1', 'https://example.test/logo.svg', '//example.test/logo.svg',
    'javascript:alert(1)', 'data:image/svg+xml,x', 'file:///tmp/logo.svg', '../logo.svg',
    'assets/../logo.svg', 'assets/%2e%2e/logo.svg', 'assets/%252e%252e/logo.svg',
    '/home/user/logo.svg', 'C:\\logo.svg', '/C:/logo.svg', '\\\\server\\logo.svg',
    'assets/logo.svg?source=/root/private.json', 'assets/logo.svg#file:///tmp/private',
    'assets/logo.svg?source=%252Froot%252Fprivate.json',
  ]) {
    assert.throws(() => render(makeFormattedCard(), logoHref), expectHtmlCode('invalid_logo_link'), logoHref);
  }
});

test('rejects malformed models, versions, profiles, links, and display values with stable codes', () => {
  assert.throws(() => renderShareCardHtml(null, { logo_href: 'logo.svg' }), expectHtmlCode('invalid_formatted_share_card'));
  assert.throws(
    () => render({ ...makeFormattedCard(), share_card_version: 'share_card_v2' }),
    expectHtmlCode('unsupported_share_card_version'),
  );
  const numberProfile = mutableClone(makeFormattedCard());
  numberProfile.formatting.number_format_version = 'host_locale';
  assert.throws(() => render(numberProfile), expectHtmlCode('unsupported_formatting_profile'));
  const dateProfile = mutableClone(makeFormattedCard());
  dateProfile.formatting.date_format_version = 'local_date';
  assert.throws(() => render(dateProfile), expectHtmlCode('unsupported_formatting_profile'));
  const extra = mutableClone(makeFormattedCard());
  extra.wallet = 'forbidden';
  assert.throws(() => render(extra), expectHtmlCode('invalid_formatted_share_card'));
  const hiddenExtra = mutableClone(makeFormattedCard());
  Object.defineProperty(hiddenExtra, 'wallet', { value: 'forbidden' });
  assert.throws(() => render(hiddenExtra), expectHtmlCode('invalid_formatted_share_card'));
  const accessor = mutableClone(makeFormattedCard());
  Object.defineProperty(accessor.display, 'pair', { get: () => 'JUP/USDC', enumerable: true });
  assert.throws(() => render(accessor), expectHtmlCode('invalid_formatted_share_card'));
  const invalidDisplay = mutableClone(makeFormattedCard());
  invalidDisplay.display.duration = '';
  assert.throws(() => render(invalidDisplay), expectHtmlCode('invalid_display_value'));
  const invalidLink = mutableClone(makeFormattedCard());
  invalidLink.links.proof_href = 'javascript:alert(1)';
  assert.throws(() => render(invalidLink), expectHtmlCode('invalid_link'));
  for (const href of [
    'proof/%252fsecret',
    'proof/%252e%252e/secret',
    'proof/item?source=/root/private.json',
  ]) {
    const card = mutableClone(makeFormattedCard());
    card.links.proof_href = href;
    assert.throws(() => render(card), expectHtmlCode('invalid_link'), href);
  }
  const malformedLinkUnicode = mutableClone(makeFormattedCard());
  malformedLinkUnicode.links.proof_href = `proof/item?value=${String.fromCharCode(0xd800)}`;
  assert.throws(() => render(malformedLinkUnicode), expectHtmlCode('unsafe_html_value'));
  for (const mutate of [
    card => { card.accounting_summary.quantity_closed = -1; },
    card => { card.trade_summary.opened_at = 253402300800; },
    card => {
      card.hero.realized_pnl_quote.value = 1;
      card.hero.realized_pnl_quote.direction = 'negative';
    },
  ]) {
    const card = mutableClone(makeFormattedCard());
    mutate(card);
    assert.throws(() => render(card), expectHtmlCode('invalid_formatted_share_card'));
  }
  let versionReads = 0;
  const versionAccessor = mutableClone(makeFormattedCard());
  Object.defineProperty(versionAccessor, 'share_card_version', {
    get() { versionReads += 1; return 'share_card_v1'; },
    enumerable: true,
  });
  assert.throws(() => render(versionAccessor), expectHtmlCode('invalid_formatted_share_card'));
  assert.equal(versionReads, 0);
  let badgeReads = 0;
  const badgeAccessor = mutableClone(makeFormattedCard());
  Object.defineProperty(badgeAccessor.badges, '0', {
    get() { badgeReads += 1; return 'Closed Position'; },
    enumerable: true,
  });
  assert.throws(() => render(badgeAccessor), expectHtmlCode('invalid_formatted_share_card'));
  assert.equal(badgeReads, 0);
  let displayKindReads = 0;
  const displayKindAccessor = mutableClone(makeFormattedCard());
  Object.defineProperty(displayKindAccessor.identity.base_asset, 'display_kind', {
    get() { displayKindReads += 1; return 'symbol'; },
    enumerable: true,
  });
  assert.throws(() => render(displayKindAccessor), expectHtmlCode('invalid_formatted_share_card'));
  assert.equal(displayKindReads, 0);
  assert.throws(
    () => renderShareCardHtml(makeFormattedCard(), { logo_href: 'logo.svg', extra: true }),
    expectHtmlCode('invalid_formatted_share_card'),
  );
});

test('renders Slice 1B strings verbatim without independently formatting raw values', () => {
  const card = mutableClone(makeFormattedCard());
  card.hero.realized_pnl_quote.value = 999999;
  card.trade_summary.opened_at = 0;
  card.trade_summary.hold_time_seconds = 1;
  card.display.realized_pnl_quote = 'PRE-FORMATTED QUOTE';
  card.display.opened_at = 'PRE-FORMATTED OPEN';
  card.display.duration = 'PRE-FORMATTED DURATION';
  const html = render(card);
  assert.ok(html.includes('PRE-FORMATTED QUOTE'));
  assert.ok(html.includes('PRE-FORMATTED OPEN'));
  assert.ok(html.includes('PRE-FORMATTED DURATION'));
  assert.equal(html.includes('999,999'), false);
  assert.equal(html.includes('1970-01-01'), false);
});

test('is deterministic across insertion order and does not mutate input', () => {
  const card = mutableClone(makeFormattedCard());
  const before = structuredClone(card);
  const normal = render(card);
  const reversed = render(reverseKeys(card));
  assert.equal(normal, reversed);
  assert.deepEqual(card, before);
});

test('contains no scripts, event handlers, remote resources, Open Graph metadata, or forbidden data', () => {
  const html = render();
  assert.equal(/<script\b/i.test(html), false);
  assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  assert.equal(/<meta[^>]+property=["']og:/i.test(html), false);
  assert.equal(/<(?:img|link|style|source|iframe)[^>]+(?:src|href)=["']https?:/i.test(html), false);
  assert.equal(/@import|url\s*\(/i.test(html), false);
  for (const forbidden of [
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    'wallet_address', 'transaction_signature', 'entry_tx_hashes', 'exit_tx_hashes',
    'Helius', 'provider', 'recovery', 'canonical_receipt_record', '/root/', 'C:\\', '$', 'N/A',
  ]) assert.equal(html.includes(forbidden), false, forbidden);
});

test('renderer source is presentation-only and contains no I/O or network APIs', () => {
  const source = readFileSync(new URL('./share-card-html.mjs', import.meta.url), 'utf8');
  for (const forbidden of [
    "from 'fs'", 'from "fs"', 'fetch(', 'XMLHttpRequest', 'WebSocket',
    'readFile', 'writeFile', 'token-display-registry', 'inventory', 'archive',
    'recovery', 'Intl.', 'toLocaleString', 'new Date(',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

console.log(`\nShare Card HTML renderer tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
