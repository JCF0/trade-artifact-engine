import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

import { buildInventorySnapshot, getInventoryReceipt } from '../inventory/inventory.mjs';
import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { buildPublishBundle } from '../proof-publish/publish-bundle.mjs';
import { buildPublishSlug } from '../proof-publish/slug.mjs';
import { buildReceiptBoardView, readReceiptBoardManifest } from '../receipt-board/view-model.mjs';
import { renderReceiptBoardHtml } from '../receipt-board/render-html.mjs';
import { assertPublicDemoLeakCheck } from './leak-check.mjs';

export const PUBLIC_DEMO_BUNDLE_VERSION = 'v1.10';
export const DEFAULT_PUBLIC_DEMO_GENERATED_AT = 'not_recorded';
const VALID_VISIBILITY = new Set(['unlisted', 'public']);
const VALID_WALLET_DISPLAY = new Set(['truncated', 'redacted']);
const REQUIRED_RECEIPT_HASHES = new Set([
  '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
  '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
]);

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!value || typeof value !== 'object') return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = stableSort(value[key]);
  return sorted;
}

export function stableJson(value) {
  return `${JSON.stringify(stableSort(value), null, 2)}\n`;
}

function normalizeVisibility(value) {
  if (value == null || value === '') return 'unlisted';
  if (!VALID_VISIBILITY.has(value)) throw new TypeError(`Unsupported public demo visibility: ${value}`);
  return value;
}

function normalizeWalletDisplay(value) {
  if (value == null || value === '') return 'truncated';
  if (!VALID_WALLET_DISPLAY.has(value)) {
    throw new TypeError(`Unsupported public demo wallet display mode: ${value}`);
  }
  return value;
}

function assertCanonicalHash(value, label = 'receipt_hash') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a 64-character lowercase hex string`);
  }
}

function selectedManifestEntries(manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  if (entries.length !== 2) throw new Error(`public demo requires exactly 2 selected receipt entries; found ${entries.length}`);
  for (const entry of entries) assertCanonicalHash(entry.receipt_hash);
  const hashes = entries.map(entry => entry.receipt_hash).sort();
  const required = [...REQUIRED_RECEIPT_HASHES].sort();
  if (stableJson(hashes) !== stableJson(required)) {
    throw new Error('public demo selected receipts must be exactly the tracked JUP and RAY receipt hashes');
  }
  return entries;
}

function assertNoArchiveDiagnostics(snapshot) {
  const diagnostics = snapshot?.archive?.diagnostics || [];
  if (diagnostics.length > 0) {
    throw new Error(`archive diagnostics present; refusing public demo build (${diagnostics.length})`);
  }
}

function assertReceiptEligible(receipt) {
  const checks = [
    ['receipt_type', receipt.receipt_type === 'closed_position'],
    ['verification_status', receipt.verification_status === 'verified'],
    ['hash_valid', receipt.hash_valid === true],
    ['verifier_schema_valid', receipt.verifier_schema_valid === true],
    ['verifier_consistency_valid', receipt.verifier_consistency_valid === true],
    ['verifier_passed', receipt.verifier_passed === true],
    ['valuation_status', receipt.valuation_status === 'raw_quote'],
  ];

  for (const [name, ok] of checks) {
    if (!ok) throw new Error(`selected receipt ${receipt.receipt_hash} failed public demo eligibility: ${name}`);
  }
}

function publicLinksFor(receiptHash) {
  const slug = buildPublishSlug(receiptHash);
  return {
    slug,
    boardProofHref: `receipts/${slug}/index.html`,
    boardProofJsonHref: `receipts/${slug}/proof.json`,
    boardVerifierHref: `verifier/${receiptHash}.json`,
    receiptBoardHref: '../../index.html',
    receiptProofJsonHref: './proof.json',
    verifierPath: `../../verifier/${receiptHash}.json`,
  };
}

function publicBoardLinks(receiptHash) {
  const links = publicLinksFor(receiptHash);
  return {
    proof_api_path: links.boardProofHref,
    verifier_api_path: links.boardVerifierHref,
    card_api_path: links.boardProofJsonHref,
    card_preview_path: '',
    hosted_preview_path: links.boardProofHref,
  };
}

function sanitizeArtifacts(artifacts = {}) {
  return {
    image_artifact_path: null,
    image_artifact_hash: artifacts.image_artifact_hash ?? null,
    metadata_name: artifacts.metadata_name ?? null,
    metadata_template_path: null,
    resolved_metadata_path: null,
    final_metadata_path: null,
    final_image_uri: artifacts.final_image_uri ?? null,
    final_metadata_uri: artifacts.final_metadata_uri ?? null,
    metadata_uri: artifacts.metadata_uri ?? null,
    image_uri: artifacts.image_uri ?? null,
    external_url: artifacts.external_url ?? null,
  };
}

function buildPublicProofDetail(receipt, walletDisplayMode) {
  const detail = buildProofDetailView(receipt);
  const links = publicLinksFor(receipt.receipt_hash);
  return {
    ...detail,
    artifacts: sanitizeArtifacts(detail.artifacts),
    links: {
      inventory_path: null,
      inventory_api_path: null,
      proof_api_path: links.receiptProofJsonHref,
      legacy_path: null,
      board_path: links.receiptBoardHref,
      verifier_path: links.verifierPath,
    },
    flags_and_limitations: {
      ...detail.flags_and_limitations,
      disclosures: [
        'Selected receipt only. Not a portfolio statement.',
        'Raw quote only. No USD normalization.',
        'Receipt-scoped coverage only. Not wallet, trader, or track-record coverage.',
        walletDisplayMode === 'redacted'
          ? 'Wallet is redacted for this public demo.'
          : 'Wallet is truncated for this public demo.',
      ],
    },
  };
}

function buildPublicVerifier(receipt) {
  const verifier = buildProofVerifierView(receipt);
  return {
    ...verifier,
    instructions: {
      mode: 'static_offline_reference',
      summary: 'Static verifier summary derived from the archived receipt inventory. This public demo does not run a server, call a network, upload, mint, sign, or connect a wallet.',
      proof_json_path: `../receipts/${buildPublishSlug(receipt.receipt_hash)}/proof.json`,
      receipt_hash: receipt.receipt_hash,
    },
  };
}

function rewriteBoard(board) {
  return {
    ...board,
    rows: board.rows.map(row => ({
      ...row,
      links: publicBoardLinks(row.receipt_hash),
    })),
  };
}

function flattenReceiptBundle(slug, bundle) {
  return {
    [`receipts/${slug}/index.html`]: bundle.files['index.html'],
    [`receipts/${slug}/proof.json`]: stableJson(bundle.proofJson),
    [`receipts/${slug}/manifest.json`]: stableJson(bundle.manifest),
  };
}

function buildSiteManifest({ board, receiptBundles, visibility, walletDisplayMode, sourceRevision, generatedAt }) {
  return {
    bundle_version: PUBLIC_DEMO_BUNDLE_VERSION,
    bundle_type: 'artifact_public_read_only_demo',
    generated_at: generatedAt,
    source_revision: sourceRevision || null,
    visibility,
    wallet_display_mode: walletDisplayMode,
    board: {
      path: 'index.html',
      json_path: 'board.json',
      board_type: board.board_type,
      selection_mode: board.selection_scope?.mode ?? null,
      rank_subject: board.ranking?.rank_subject ?? null,
      ranking_metric: board.ranking?.metric ?? null,
      pnl_scope: board.ranking?.pnl_scope ?? null,
      receipt_count: board.rows.length,
    },
    receipts: receiptBundles.map(item => ({
      receipt_hash: item.receiptHash,
      slug: item.slug,
      index_path: `receipts/${item.slug}/index.html`,
      proof_json_path: `receipts/${item.slug}/proof.json`,
      verifier_json_path: `verifier/${item.receiptHash}.json`,
    })),
    constraints: {
      read_only_static_files: true,
      selected_receipts_only: true,
      verified_closed_position_only: true,
      raw_quote_only: true,
      no_runtime_server: true,
      no_database: true,
      no_network_calls: true,
      no_upload_mint_signing_or_wallet_connection: true,
    },
  };
}

export function buildPublicDemoBundle(options = {}) {
  const engineRoot = options.engineRoot ? resolve(options.engineRoot) : DEFAULT_ENGINE_ROOT;
  const visibility = normalizeVisibility(options.visibility);
  const walletDisplayMode = normalizeWalletDisplay(options.walletDisplayMode);
  const generatedAt = options.generatedAt || DEFAULT_PUBLIC_DEMO_GENERATED_AT;
  const sourceRevision = options.sourceRevision || null;

  const manifest = readReceiptBoardManifest({ engineRoot });
  if (!manifest) throw new Error('tracked board manifest not found');
  const entries = selectedManifestEntries(manifest);
  const selectedHashes = entries.map(entry => entry.receipt_hash);

  const snapshot = buildInventorySnapshot({
    engineRoot,
    includeArchive: true,
    includeLegacy: false,
    includeExcluded: false,
  });
  assertNoArchiveDiagnostics(snapshot);

  const receipts = selectedHashes.map(receiptHash => {
    const receipt = getInventoryReceipt(receiptHash, {
      engineRoot,
      includeArchive: true,
      includeExcluded: false,
    });
    if (!receipt) throw new Error(`selected receipt missing from archive-enabled inventory: ${receiptHash}`);
    assertReceiptEligible(receipt);
    return receipt;
  });

  const board = rewriteBoard(buildReceiptBoardView({
    engineRoot,
    includeExcluded: false,
    manifest,
  }));

  if (board.rows.length !== selectedHashes.length) {
    throw new Error(`public demo board row count mismatch: expected ${selectedHashes.length}, got ${board.rows.length}`);
  }

  const receiptBundles = receipts
    .map(receipt => {
      const proofDetail = buildPublicProofDetail(receipt, walletDisplayMode);
      const bundle = buildPublishBundle(proofDetail, {
        generatedAt,
        visibility,
        wallet_display_mode: walletDisplayMode,
        base_url: null,
      });
      return {
        receiptHash: receipt.receipt_hash,
        slug: bundle.slug,
        bundle,
        verifier: buildPublicVerifier(receipt),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const files = {
    'index.html': renderReceiptBoardHtml(board),
    'board.json': stableJson(board),
    'manifest.json': stableJson(buildSiteManifest({
      board,
      receiptBundles,
      visibility,
      walletDisplayMode,
      sourceRevision,
      generatedAt,
    })),
  };

  for (const item of receiptBundles) {
    Object.assign(files, flattenReceiptBundle(item.slug, item.bundle));
    files[`verifier/${item.receiptHash}.json`] = stableJson(item.verifier);
  }

  const orderedFiles = {};
  for (const filename of Object.keys(files).sort()) orderedFiles[filename] = files[filename];
  const leakCheck = assertPublicDemoLeakCheck(orderedFiles, { expectedReceiptHashes: selectedHashes });

  return {
    manifest,
    board,
    receipts,
    files: orderedFiles,
    fileList: Object.keys(orderedFiles),
    leakCheck,
  };
}

function assertRelativeBundlePath(path) {
  if (isAbsolute(path) || path.includes('..') || path.split(/[\\/]/).some(part => part === '')) {
    throw new Error(`unsafe bundle path: ${path}`);
  }
}

function assertOutputRoot(outRoot) {
  if (!outRoot) throw new Error('--out is required for write mode');
  const resolved = resolve(outRoot);
  if (resolved === resolve(sep)) throw new Error('refusing to write to filesystem root');
  return resolved;
}

function isDirectoryEmpty(path) {
  return !existsSync(path) || readdirSync(path).length === 0;
}

export function writePublicDemoBundle(bundle, options = {}) {
  const outRoot = assertOutputRoot(options.outRoot);
  const force = options.force === true;

  if (existsSync(outRoot)) {
    if (!statSync(outRoot).isDirectory()) throw new Error(`output path exists and is not a directory: ${outRoot}`);
    if (!force && !isDirectoryEmpty(outRoot)) {
      throw new Error(`output directory is not empty: ${outRoot}. Re-run with --force to replace it.`);
    }
    if (force) {
      for (const name of readdirSync(outRoot)) rmSync(resolve(outRoot, name), { recursive: true, force: true });
    }
  }

  mkdirSync(outRoot, { recursive: true });
  const written = [];
  for (const filename of Object.keys(bundle.files).sort()) {
    assertRelativeBundlePath(filename);
    const target = resolve(outRoot, filename);
    const rel = relative(outRoot, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`refusing to write outside output root: ${filename}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bundle.files[filename], 'utf8');
    written.push(target);
  }

  return {
    outRoot,
    files: written,
  };
}
