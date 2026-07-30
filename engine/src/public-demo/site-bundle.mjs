import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'path';

import { buildInventorySnapshot, getInventoryReceiptProofSource } from '../inventory/inventory.mjs';
import { resolveTokenDisplayMetadata } from '../display-metadata/token-display-registry.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { buildProofVerifierView } from '../proof-verifier/view-model.mjs';
import { buildPublishBundle } from '../proof-publish/publish-bundle.mjs';
import { buildPublishSlug } from '../proof-publish/slug.mjs';
import { buildReceiptBoardView, readReceiptBoardManifest } from '../receipt-board/view-model.mjs';
import { renderReceiptBoardHtml } from '../receipt-board/render-html.mjs';
import { formatShareCardViewModel } from '../share-card/share-card-format.mjs';
import { renderShareCardHtml } from '../share-card/share-card-html.mjs';
import { buildShareCardViewModel } from '../share-card/share-card-view-model.mjs';
import { assertPublicDemoLeakCheck } from './leak-check.mjs';
import { derivePublicDemoBrandAssets } from './brand-assets.mjs';
import { PUBLIC_DEMO_ASSET_BASE, PUBLIC_DEMO_PROOF_ASSET_BASE, renderBrandHeader, renderFaviconLink, renderPublicDemoStyles } from './visual-system.mjs';

export const PUBLIC_DEMO_BUNDLE_VERSION = 'v1.11';
export const DEFAULT_PUBLIC_DEMO_GENERATED_AT = 'not_recorded';
export const PUBLIC_DEMO_HEADERS = `/*
  Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  X-Robots-Tag: noindex, nofollow
`;
export const PUBLIC_DEMO_ROBOTS = `User-agent: *
Disallow: /
`;

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

function requireExplicitRoot(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`An explicit ${label} root is required`);
  }
  return resolve(value);
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
    boardShareHref: `share/${receiptHash}/index.html`,
    receiptShareHref: `../../share/${receiptHash}/index.html`,
    shareProofHref: `../../receipts/${slug}/index.html`,
    shareVerifierHref: `../../verifier/${receiptHash}.json`,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function addShareCardMetadata(html, formattedModel) {
  const description = `Verified closed-position receipt for ${formattedModel.display.pair}: realized PnL ${formattedModel.display.realized_pnl_quote} in raw quote.`;
  const marker = '  <meta name="robots" content="noindex,nofollow">\n';
  if (!html.includes(marker)) throw new Error('Share Card renderer output is missing required robots metadata');
  return html.replace(marker, `${marker}  <meta name="description" content="${escapeHtml(description)}">\n`);
}

function buildPublicShareCard(receipt, proofSource) {
  if (receipt.canonical_economics?.status !== 'verified') return null;
  const links = publicLinksFor(receipt.receipt_hash);
  const model = buildShareCardViewModel(proofSource, {
    tokenDisplayMetadata: resolveTokenDisplayMetadata(receipt.token_mint),
    links: {
      proof_href: links.shareProofHref,
      verifier_href: links.shareVerifierHref,
    },
  });
  const formattedModel = formatShareCardViewModel(model);
  const html = addShareCardMetadata(renderShareCardHtml(formattedModel, {
    logo_href: '/assets/artifact-logo-header.png',
  }), formattedModel);
  return {
    receiptHash: receipt.receipt_hash,
    path: `share/${receipt.receipt_hash}/index.html`,
    formattedModel,
    html,
  };
}

function publicBoardLinks(receiptHash, shareCardEligible) {
  const links = publicLinksFor(receiptHash);
  return {
    proof_api_path: links.boardProofHref,
    verifier_api_path: links.boardVerifierHref,
    card_api_path: links.boardProofJsonHref,
    card_preview_path: '',
    hosted_preview_path: links.boardProofHref,
    ...(shareCardEligible ? { share_card_path: links.boardShareHref } : {}),
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

function buildPublicProofDetail(receipt, proofSource, walletDisplayMode, shareCardEligible) {
  const detail = buildProofDetailView(proofSource);
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
      ...(shareCardEligible ? { share_card_path: links.receiptShareHref } : {}),
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

function buildPublicVerifier(receipt, proofSource) {
  const verifier = buildProofVerifierView(proofSource);
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

function rewriteBoard(board, shareCardHashes) {
  return {
    ...board,
    rows: board.rows.map(row => ({
      ...row,
      links: publicBoardLinks(row.receipt_hash, shareCardHashes.has(row.receipt_hash)),
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

function renderNotFoundPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Artifact Public Demo - Not Found</title>
  ${renderFaviconLink(PUBLIC_DEMO_ASSET_BASE)}
  <style>
    ${renderPublicDemoStyles()}
    .not-found-panel { padding: 26px; }
  </style>
</head>
<body>
  <main class="page-shell">
    ${renderBrandHeader({ assetBasePath: PUBLIC_DEMO_ASSET_BASE, current: 'proof', backHref: './index.html' })}
    <section class="hero-panel not-found-panel">
      <h1>Page not found</h1>
      <p class="lead">This is a static unlisted Artifact demonstration.</p>
      <a class="button-link primary" href="./index.html">Return to the receipt board</a>
    </section>
  </main>
</body>
</html>`;
}

function buildSiteManifest({ board, receiptBundles, shareCards, visibility, walletDisplayMode, sourceRevision, generatedAt, brandAssets }) {
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
    hosting: {
      target: 'cloudflare_pages_direct_upload',
      default_pages_dev_url_only: true,
      github_integration: false,
      custom_domain: false,
      functions: false,
      environment_variables: false,
      headers_path: '_headers',
      robots_path: 'robots.txt',
      not_found_path: '404.html',
      unlisted_not_private: true,
    },
    receipts: receiptBundles.map(item => ({
      receipt_hash: item.receiptHash,
      slug: item.slug,
      index_path: `receipts/${item.slug}/index.html`,
      proof_json_path: `receipts/${item.slug}/proof.json`,
      verifier_json_path: `verifier/${item.receiptHash}.json`,
      ...(shareCards.some(card => card.receiptHash === item.receiptHash) ? {
        share_card_path: `share/${item.receiptHash}/index.html`,
      } : {}),
    })),
    share_cards: shareCards.map(card => ({
      receipt_hash: card.receiptHash,
      path: card.path,
      pair: card.formattedModel.display.pair,
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
    assets: brandAssets ? {
      source: brandAssets.source,
      derivation: brandAssets.derivation,
      files: Object.fromEntries(Object.entries(brandAssets.assets).map(([path, bytes]) => [path, {
        bytes: bytes.length,
        sha256: brandAssets.hashes[path],
      }])),
    } : null,
  };
}

export function buildPublicDemoBundle(options = {}) {
  const engineRoot = requireExplicitRoot(options.engineRoot, 'engine');
  const packageRoot = options.packageRoot === undefined
    ? undefined
    : requireExplicitRoot(options.packageRoot, 'package');
  const archiveRoot = requireExplicitRoot(options.archiveRoot, 'archive');
  const economicsRoot = requireExplicitRoot(options.economicsRoot, 'economics');
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
    ...(packageRoot === undefined ? {} : { packageRoot }),
    archiveRoot,
    economicsRoot,
    includeArchive: true,
    includeLegacy: false,
    includeExcluded: false,
  });
  const buildFromSnapshot = resolvedSnapshot => {
    assertNoArchiveDiagnostics(resolvedSnapshot);
    const receiptByHash = new Map(resolvedSnapshot.receipts.map(receipt => [receipt.receipt_hash, receipt]));
    const receipts = selectedHashes.map(receiptHash => {
      const receipt = receiptByHash.get(receiptHash);
      if (!receipt) throw new Error(`selected receipt missing from archive-enabled inventory: ${receiptHash}`);
      assertReceiptEligible(receipt);
      return receipt;
    });
    const proofSourceByHash = new Map(receipts.map(receipt => [
      receipt.receipt_hash,
      getInventoryReceiptProofSource(resolvedSnapshot, receipt.receipt_hash),
    ]));
    const shareCards = receipts
      .map(receipt => buildPublicShareCard(receipt, proofSourceByHash.get(receipt.receipt_hash)))
      .filter(Boolean)
      .sort((a, b) => a.path.localeCompare(b.path));
    const shareCardHashes = new Set(shareCards.map(card => card.receiptHash));
    const boardResult = buildReceiptBoardView({
      engineRoot,
      ...(packageRoot === undefined ? {} : { packageRoot }),
      archiveRoot,
      economicsRoot,
      includeExcluded: false,
      manifest,
    });

    const finish = resolvedBoard => {
      const board = rewriteBoard(resolvedBoard, shareCardHashes);
      if (board.rows.length !== selectedHashes.length) {
        throw new Error(`public demo board row count mismatch: expected ${selectedHashes.length}, got ${board.rows.length}`);
      }
      const brandAssets = derivePublicDemoBrandAssets();
      const receiptBundles = receipts
        .map(receipt => {
          const proofSource = proofSourceByHash.get(receipt.receipt_hash);
          const proofDetail = buildPublicProofDetail(
            receipt,
            proofSource,
            walletDisplayMode,
            shareCardHashes.has(receipt.receipt_hash),
          );
          const bundle = buildPublishBundle(proofDetail, {
            generatedAt,
            visibility,
            wallet_display_mode: walletDisplayMode,
            base_url: null,
            asset_base_path: PUBLIC_DEMO_PROOF_ASSET_BASE,
          });
          return {
            receiptHash: receipt.receipt_hash,
            slug: bundle.slug,
            bundle,
            verifier: buildPublicVerifier(receipt, proofSource),
          };
        })
        .sort((a, b) => a.slug.localeCompare(b.slug));
      const files = {
        'index.html': renderReceiptBoardHtml(board, { assetBasePath: PUBLIC_DEMO_ASSET_BASE }),
        'board.json': stableJson(board),
        'manifest.json': stableJson(buildSiteManifest({
          board,
          receiptBundles,
          shareCards,
          visibility,
          walletDisplayMode,
          sourceRevision,
          generatedAt,
          brandAssets,
        })),
        '_headers': PUBLIC_DEMO_HEADERS,
        'robots.txt': PUBLIC_DEMO_ROBOTS,
        '404.html': renderNotFoundPage(),
        ...brandAssets.assets,
      };
      for (const item of receiptBundles) {
        Object.assign(files, flattenReceiptBundle(item.slug, item.bundle));
        files[`verifier/${item.receiptHash}.json`] = stableJson(item.verifier);
      }
      for (const card of shareCards) files[card.path] = card.html;
      const orderedFiles = {};
      for (const filename of Object.keys(files).sort()) orderedFiles[filename] = files[filename];
      const leakCheck = assertPublicDemoLeakCheck(orderedFiles, { expectedReceiptHashes: selectedHashes });
      return {
        manifest,
        board,
        receipts,
        brandAssets,
        shareCards,
        files: orderedFiles,
        fileList: Object.keys(orderedFiles),
        leakCheck,
      };
    };
    return typeof boardResult?.then === 'function' ? boardResult.then(finish) : finish(boardResult);
  };
  return typeof snapshot?.then === 'function' ? snapshot.then(buildFromSnapshot) : buildFromSnapshot(snapshot);
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
    const content = bundle.files[filename];
    if (Buffer.isBuffer(content)) writeFileSync(target, content);
    else writeFileSync(target, content, 'utf8');
    written.push(target);
  }

  return {
    outRoot,
    files: written,
  };
}