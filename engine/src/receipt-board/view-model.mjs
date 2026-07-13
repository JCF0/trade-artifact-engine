import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

import { buildInventorySnapshot } from '../inventory/inventory.mjs';
import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofCardView } from '../proof-card/view-model.mjs';

export const RECEIPT_BOARD_MANIFEST_PATH = 'samples/historical-receipt-board.manifest.json';
export const BOARD_TYPE = 'artifact_historical_verified_receipt_board';
export const SUPPORTED_RANKING_METRIC = 'trust_then_time';
export const BOARD_ELIGIBLE_VERIFICATION_STATUSES = new Set(['verified']);

export const RECEIPT_BOARD_DISCLOSURES = [
  'Ranks selected receipts only. Not traders, wallets, portfolios, or skill.',
  'Selected receipt only. Not a portfolio statement.',
  'Raw quote only. No USD normalization.',
  'Publisher-selected sample set unless an explicit coverage scope is supplied.',
  'No live trading, prize eligibility, anti-wash-trading, or full-track-record claim.',
];

const DEFAULT_TITLE = 'Historical Verified Receipt Board';
const DEFAULT_SUBTITLE = 'Selected historical receipts only. Not a trader leaderboard.';
const DEFAULT_SELECTION_SCOPE = {
  mode: 'publisher_selected',
  statement: 'Publisher-selected sample receipts for local prototype demonstration.',
};
const DEFAULT_RANKING = {
  metric: SUPPORTED_RANKING_METRIC,
  direction: 'desc',
  rank_subject: 'receipt',
  pnl_scope: 'none',
};

function isCanonicalReceiptHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function shortenHash(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length <= 16) return value;
  return `${value.slice(0, 8)}...${value.slice(-8)}`;
}

function normalizeManifest(manifest = {}) {
  const source = manifest && typeof manifest === 'object' ? manifest : {};
  return {
    version: source.version || '1.0.0',
    board_id: source.board_id || 'historical_verified_receipt_board_demo',
    title: source.title || DEFAULT_TITLE,
    subtitle: source.subtitle || DEFAULT_SUBTITLE,
    selection_scope: {
      ...DEFAULT_SELECTION_SCOPE,
      ...(source.selection_scope && typeof source.selection_scope === 'object' ? source.selection_scope : {}),
    },
    ranking: {
      ...DEFAULT_RANKING,
      ...(source.ranking && typeof source.ranking === 'object' ? source.ranking : {}),
    },
    entries: Array.isArray(source.entries) ? source.entries : [],
  };
}

function normalizeEntry(entry = {}, index = 0) {
  return {
    receipt_hash: typeof entry.receipt_hash === 'string' ? entry.receipt_hash : null,
    display_name: typeof entry.display_name === 'string' && entry.display_name.length > 0
      ? entry.display_name
      : `Entry ${index + 1}`,
    participant_ref: typeof entry.participant_ref === 'string' ? entry.participant_ref : null,
    selection_note: typeof entry.selection_note === 'string' ? entry.selection_note : null,
  };
}

function isSupportedRanking(ranking = {}) {
  return ranking.metric === SUPPORTED_RANKING_METRIC
    && ranking.direction === 'desc'
    && ranking.rank_subject === 'receipt'
    && ranking.pnl_scope === 'none';
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildExcludedEntry(entry, reason) {
  return {
    receipt_hash: entry.receipt_hash,
    display_name: entry.display_name,
    reason,
  };
}

function getReceiptTime(receipt = {}) {
  const candidates = [
    receipt.last_event_at,
    receipt.snapshot_at,
    receipt.first_event_at,
  ];
  for (const value of candidates) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function validateVerifiedReceipt(receipt) {
  if (receipt.hash_valid !== true) return 'hash_invalid';
  if (receipt.verifier_passed !== true) return 'verifier_failed';
  if (receipt.verifier_schema_valid !== true) return 'schema_invalid';
  if (receipt.verifier_consistency_valid !== true) return 'consistency_invalid';
  if (!BOARD_ELIGIBLE_VERIFICATION_STATUSES.has(receipt.verification_status)) {
    return 'verification_status_not_board_eligible';
  }
  return null;
}

function buildLinks(receiptHash) {
  return {
    proof_api_path: `/api/proof/${receiptHash}`,
    verifier_api_path: `/api/verifier/${receiptHash}`,
    card_api_path: `/api/proof/${receiptHash}/card`,
    card_preview_path: `/api/proof/${receiptHash}/card/preview`,
    hosted_preview_path: `/api/proof/${receiptHash}/hosted-preview`,
  };
}

function buildRow(entry, receipt) {
  const proofDetail = buildProofDetailView(receipt);
  const cardView = buildProofCardView(proofDetail);
  const trust = {
    current_level: cardView.trust.current_level,
    current_code: cardView.trust.current_code,
    current_label: cardView.trust.current_label,
  };

  return {
    rank: null,
    display_name: entry.display_name,
    participant_ref: entry.participant_ref,
    selection_note: entry.selection_note,
    receipt_hash: receipt.receipt_hash,
    receipt_hash_short: cardView.receipt.receipt_hash_short || shortenHash(receipt.receipt_hash),
    receipt_id: receipt.receipt_id,
    receipt_type: receipt.receipt_type,
    token_display: cardView.receipt.token_display,
    verification_status: receipt.verification_status,
    valuation_status: receipt.valuation_status,
    trust,
    ranking_metric: {
      metric: SUPPORTED_RANKING_METRIC,
      value: trust.current_level,
      display: trust.current_label,
    },
    links: buildLinks(receipt.receipt_hash),
    _sort: {
      trust_level: trust.current_level ?? 0,
      receipt_time: getReceiptTime(receipt),
      receipt_hash: receipt.receipt_hash,
    },
  };
}

function finalizeRows(rows) {
  return rows
    .sort((a, b) => {
      if (b._sort.trust_level !== a._sort.trust_level) return b._sort.trust_level - a._sort.trust_level;
      if (b._sort.receipt_time !== a._sort.receipt_time) return b._sort.receipt_time - a._sort.receipt_time;
      return a._sort.receipt_hash.localeCompare(b._sort.receipt_hash);
    })
    .map((row, index) => {
      const { _sort, ...publicRow } = row;
      return {
        ...publicRow,
        rank: index + 1,
      };
    });
}

export function readReceiptBoardManifest({ engineRoot = DEFAULT_ENGINE_ROOT } = {}) {
  const manifestPath = resolve(engineRoot, RECEIPT_BOARD_MANIFEST_PATH);
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return {
    path: manifestPath,
    ...normalizeManifest(manifest),
  };
}

export function buildReceiptBoardView(options = {}) {
  const engineRoot = options.engineRoot || DEFAULT_ENGINE_ROOT;
  const includeExcluded = options.includeExcluded !== false;
  const offset = Math.max(0, toInteger(options.offset, 0));
  const limit = options.limit == null ? null : Math.max(0, toInteger(options.limit, Number.MAX_SAFE_INTEGER));
  const manifest = normalizeManifest(
    options.manifest === undefined
      ? readReceiptBoardManifest({ engineRoot })
      : options.manifest
  );
  const rows = [];
  const excludedEntries = [];
  const rankingSupported = isSupportedRanking(manifest.ranking);
  const snapshot = buildInventorySnapshot({
    engineRoot,
    includeLegacy: false,
    includeExcluded: false,
  });
  const receiptByHash = new Map(snapshot.receipts.map(receipt => [receipt.receipt_hash, receipt]));

  manifest.entries.map(normalizeEntry).forEach(entry => {
    if (!isCanonicalReceiptHash(entry.receipt_hash)) {
      excludedEntries.push(buildExcludedEntry(entry, 'malformed_receipt_hash'));
      return;
    }

    if (!rankingSupported) {
      excludedEntries.push(buildExcludedEntry(entry, 'unsupported_metric'));
      return;
    }

    const receipt = receiptByHash.get(entry.receipt_hash);
    if (!receipt) {
      excludedEntries.push(buildExcludedEntry(entry, 'missing_receipt'));
      return;
    }

    const invalidReason = validateVerifiedReceipt(receipt);
    if (invalidReason) {
      excludedEntries.push(buildExcludedEntry(entry, invalidReason));
      return;
    }

    rows.push(buildRow(entry, receipt));
  });

  const rankedRows = finalizeRows(rows);
  const pagedRows = limit == null
    ? rankedRows.slice(offset)
    : rankedRows.slice(offset, offset + limit);

  return {
    board_type: BOARD_TYPE,
    title: manifest.title,
    subtitle: manifest.subtitle,
    selection_scope: manifest.selection_scope,
    ranking: manifest.ranking,
    count: pagedRows.length,
    empty: pagedRows.length === 0,
    disclosures: [...RECEIPT_BOARD_DISCLOSURES],
    rows: pagedRows,
    excluded_entries: includeExcluded ? excludedEntries : [],
  };
}
