import assert from 'assert';

import { renderReceiptBoardHtml } from './render-html.mjs';

let pass = 0;
let fail = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass += 1;
      console.log(`  PASS ${name}`);
    })
    .catch(error => {
      fail += 1;
      console.log(`  FAIL ${name}`);
      console.log(`       ${error.message}`);
    });
}

function sampleCoverageStatement(overrides = {}) {
  return {
    coverage_statement_version: 'receipt_coverage_v1',
    coverage_status: 'complete',
    coverage_codes: ['receipt_scope_only', 'event_bounds_complete'],
    scope: {
      scope_type: 'receipt',
      coverage_basis: 'canonical_inventory_receipt',
    },
    receipt: {
      receipt_hash: 'a'.repeat(64),
      receipt_id: 'art_v12_cp_TEST_0',
      receipt_type: 'closed_position',
      receipt_version: '1.2.0',
    },
    position_episode: {
      semantic: 'closed_position_receipt_episode',
      opened_at: 1700000000,
      closed_at: 1700000300,
      snapshot_at: null,
      time_basis: 'receipt_first_last_event_at',
      descriptive_only: true,
    },
    verification_basis: {
      verification_status: 'verified',
      hash_valid: true,
      verifier_passed: true,
      schema_valid: true,
      consistency_valid: true,
      rule_violations: [],
    },
    valuation_basis: {
      valuation_status: 'raw_quote',
      valuation_currency: 'raw_quote',
      quote_symbol: 'SOL',
      quote_mint: 'So11111111111111111111111111111111111111112',
      usd_normalized: false,
    },
    publication_context: {
      surface: 'historical_receipt_board',
      selection_mode: 'publisher_selected',
    },
    limitations: [],
    ...overrides,
  };
}

function sampleBoard(overrides = {}) {
  return {
    board_type: 'artifact_historical_verified_receipt_board',
    title: 'Historical Verified Receipt Board',
    subtitle: 'Selected historical receipts only. Not a trader leaderboard.',
    selection_scope: {
      mode: 'publisher_selected',
      statement: 'Publisher-selected sample receipts for local prototype demonstration.',
    },
    ranking: {
      metric: 'trust_then_time',
      direction: 'desc',
      rank_subject: 'receipt',
      pnl_scope: 'none',
    },
    count: 1,
    empty: false,
    disclosures: [
      'Ranks selected receipts only. Not traders, wallets, portfolios, or skill.',
      'Selected receipt only. Not a portfolio statement.',
      'Raw quote only. No USD normalization.',
      'Publisher-selected sample set unless an explicit coverage scope is supplied.',
      'No live trading, prize eligibility, anti-wash-trading, or full-track-record claim.',
    ],
    rows: [
      {
        rank: 1,
        display_name: 'Entry 1',
        participant_ref: 'local-entry-1',
        selection_note: 'Demo receipt selected by publisher.',
        receipt_hash: 'a'.repeat(64),
        receipt_hash_short: 'aaaaaaaa...aaaaaaaa',
        receipt_id: 'art_v12_cp_TEST_0',
        receipt_type: 'closed_position',
        token_display: 'TEST_TOKEN_A',
        verification_status: 'verified',
        valuation_status: 'raw_quote',
        trust: {
          current_level: 4,
          current_code: 'source_anchored',
          current_label: 'Source Anchored',
        },
        ranking_metric: {
          metric: 'trust_then_time',
          value: 4,
          display: 'Source Anchored',
        },
        coverage_statement: sampleCoverageStatement(),
        links: {
          proof_api_path: '/api/proof/' + 'a'.repeat(64),
          verifier_api_path: '/api/verifier/' + 'a'.repeat(64),
          card_api_path: '/api/proof/' + 'a'.repeat(64) + '/card',
          card_preview_path: '/api/proof/' + 'a'.repeat(64) + '/card/preview',
          hosted_preview_path: '/api/proof/' + 'a'.repeat(64) + '/hosted-preview',
        },
      },
    ],
    excluded_entries: [],
    ...overrides,
  };
}

await test('renders title, subtitle, and disclosures', () => {
  const html = renderReceiptBoardHtml(sampleBoard());

  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>Historical Verified Receipt Board</title>'));
  assert.ok(html.includes('<h1>Historical Verified Receipt Board</h1>'));
  assert.ok(html.includes('Verifiable receipts for on-chain trades.'));
  assert.ok(html.includes('Publisher-selected verified receipts. Receipt-ranked, not trader-ranked.'));
  assert.ok(html.includes('Ranks selected receipts only. Not traders, wallets, portfolios, or skill.'));
  assert.ok(html.includes('Raw quote only. No USD normalization.'));
});

await test('renders rows with receipt-entry framing', () => {
  const html = renderReceiptBoardHtml(sampleBoard());

  assert.ok(html.includes('Receipt entries only'));
  assert.ok(html.includes('Receipt Rank'));
  assert.ok(html.includes('Entry 1'));
  assert.ok(html.includes('Entry reference:'));
  assert.ok(html.includes('local-entry-1'));
  assert.ok(html.includes('Demo receipt selected by publisher.'));
  assert.ok(html.includes('aaaaaaaa...aaaaaaaa'));
  assert.ok(html.includes('Receipt Type'));
  assert.ok(html.includes('Verification'));
  assert.ok(html.includes('Valuation'));
  assert.ok(html.includes('Trust'));
});


await test('renders compact coverage statement from row coverage without internal codes', () => {
  const html = renderReceiptBoardHtml(sampleBoard());

  assert.ok(html.includes('Coverage Statement'));
  assert.ok(html.includes('Receipt-scoped coverage only.'));
  assert.ok(html.includes('Receipt event bounds: 2023-11-14T22:13:20.000Z to 2023-11-14T22:18:20.000Z.'));
  assert.ok(html.includes('Raw quote only. No USD normalization.'));
  assert.ok(html.includes('Publisher-selected board entry.'));
  assert.ok(html.includes('Not wallet, trader, portfolio, or track-record coverage.'));
  assert.ok(!html.includes('coverage_codes'));
  assert.ok(!html.includes('event_bounds_complete'));
});

await test('renders incomplete board coverage bounds deterministically', () => {
  const board = sampleBoard();
  board.rows[0].coverage_statement = sampleCoverageStatement({
    position_episode: {
      ...sampleCoverageStatement().position_episode,
      opened_at: null,
      closed_at: null,
    },
  });
  const html = renderReceiptBoardHtml(board);

  assert.ok(html.includes('Receipt event bounds incomplete.'));
});

await test('includes all required links', () => {
  const hash = 'a'.repeat(64);
  const html = renderReceiptBoardHtml(sampleBoard());

  assert.ok(html.includes(`/api/proof/${hash}`));
  assert.ok(html.includes(`/api/verifier/${hash}`));
  assert.ok(html.includes(`/api/proof/${hash}/card`));
  assert.ok(html.includes(`/api/proof/${hash}/card/preview`));
  assert.ok(html.includes(`/api/proof/${hash}/hosted-preview`));
});

await test('renders excluded entries separately and not as ranked rows', () => {
  const html = renderReceiptBoardHtml(sampleBoard({
    rows: [],
    excluded_entries: [
      {
        receipt_hash: 'bad',
        display_name: 'Excluded Entry',
        reason: 'malformed_receipt_hash',
      },
    ],
  }));

  assert.ok(html.includes('Excluded entries'));
  assert.ok(html.includes('Excluded Entry'));
  assert.ok(html.includes('malformed_receipt_hash'));
  assert.equal((html.match(/Receipt Rank/g) || []).length, 0);
});

await test('renders empty board cleanly', () => {
  const html = renderReceiptBoardHtml(sampleBoard({
    count: 0,
    empty: true,
    rows: [],
  }));

  assert.ok(html.includes('No verified receipt entries are currently available for this board.'));
});

await test('escapes display, participant, selection, title, subtitle, token, and link fields', () => {
  const html = renderReceiptBoardHtml(sampleBoard({
    title: '<Title & "Board">',
    subtitle: '<Subtitle>',
    rows: [
      {
        ...sampleBoard().rows[0],
        display_name: '<Entry & "One">',
        participant_ref: '<ref>',
        selection_note: '<note>',
        token_display: '<TOKEN>',
        coverage_statement: sampleCoverageStatement(),
        links: {
          proof_api_path: '/api/proof/<bad>',
          verifier_api_path: '/api/verifier/"bad"',
          card_api_path: '/api/proof/card?x=<bad>',
          card_preview_path: '/api/proof/card/preview?x="bad"',
          hosted_preview_path: '/api/proof/hosted?x=<bad>&y=1',
        },
      },
    ],
  }));

  assert.ok(html.includes('&lt;Title &amp; &quot;Board&quot;&gt;'));
  assert.ok(html.includes('&lt;Subtitle&gt;'));
  assert.ok(html.includes('&lt;Entry &amp; &quot;One&quot;&gt;'));
  assert.ok(html.includes('&lt;ref&gt;'));
  assert.ok(html.includes('&lt;note&gt;'));
  assert.ok(html.includes('&lt;TOKEN&gt;'));
  assert.ok(html.includes('/api/proof/&lt;bad&gt;'));
  assert.ok(html.includes('/api/verifier/&quot;bad&quot;'));
  assert.ok(!html.includes('<Entry & "One">'));
  assert.ok(!html.includes('<TOKEN>'));
});

await test('has no scripts, external CSS, external assets, remote fonts, or images', () => {
  const html = renderReceiptBoardHtml(sampleBoard());

  assert.ok(!/<script\b/i.test(html));
  assert.ok(!/<link\b/i.test(html));
  assert.ok(!/<img\b/i.test(html));
  assert.ok(!/@import/i.test(html));
  assert.ok(!/url\(/i.test(html));
  assert.ok(!/https?:\/\//i.test(html));
});

await test('avoids leaderboard, best-trader, top-wallet, and performance language except negative disclaimers', () => {
  const html = renderReceiptBoardHtml(sampleBoard());
  const normalized = html.toLowerCase();

  assert.ok(!normalized.includes('best trader'));
  assert.ok(!normalized.includes('top wallet'));
  assert.ok(!normalized.includes('wallet rank'));
  assert.ok(!normalized.includes('winner'));
  assert.ok(!normalized.includes('performance'));
  assert.ok(!normalized.includes('track record'));
  assert.ok(normalized.includes('not trader-ranked'));
  assert.ok(normalized.includes('not a trader leaderboard'));
  assert.ok(normalized.includes('not traders, wallets, portfolios, or skill'));
  assert.ok(normalized.includes('not a portfolio statement'));
  assert.ok(normalized.includes('full-track-record claim'));
});

await test('does not include PnL, lifecycle, upload, mint, transaction, or artifact fields', () => {
  const html = renderReceiptBoardHtml(sampleBoard());
  const normalized = html.toLowerCase();

  assert.ok(!normalized.includes('pnl'));
  assert.ok(!normalized.includes('usd value'));
  assert.ok(!normalized.includes('usd return'));
  assert.ok(!normalized.includes('usd-normalized'));
  assert.ok(normalized.includes('no usd normalization'));
  assert.ok(!normalized.includes('lifecycle'));
  assert.ok(!normalized.includes('upload'));
  assert.ok(!normalized.includes('mint address'));
  assert.ok(!normalized.includes('transaction signature'));
  assert.ok(!normalized.includes('token account'));
  assert.ok(!normalized.includes('proof wallet'));
  assert.ok(!normalized.includes('mint authority'));
  assert.ok(!normalized.includes('artifact uri'));
});

await test('does not mutate the board view-model', () => {
  const board = sampleBoard();
  const before = JSON.stringify(board);

  renderReceiptBoardHtml(board);

  assert.equal(JSON.stringify(board), before);
});

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
