import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ENGINE_ROOT = resolve(__dirname, '..', '..');

export const V12_DEBUG_ARTIFACTS = Object.freeze({
  receipts: 'data/debug/ledger-receipts-v12.json',
  verify: 'data/debug/ledger-verify-v12.json',
  valuations: 'data/debug/ledger-valuations-v12.json',
  imageArtifacts: 'data/debug/ledger-image-artifacts-v12.json',
  metadata: 'data/debug/ledger-metadata-v12.json',
  uploadDryRun: 'data/debug/ledger-upload-dry-run-v12.json',
  uploadResults: 'data/debug/ledger-upload-results-v12.json',
  mintPlan: 'data/debug/ledger-mint-plan-v12.json',
  mintResults: 'data/debug/ledger-mint-results-v12.json',
  proofSummary: 'data/debug/v12-proof-pipeline-summary.json',
});

const EXCLUDED_SEGMENT_PATTERNS = [
  /^_test$/i,
  /^_e2e_test$/i,
  /backup/i,
];

function normalizeArrayPayload(payload, arrayKey) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (arrayKey && Array.isArray(payload[arrayKey])) return payload[arrayKey];
  return [];
}

function safeReadJson(absPath) {
  if (!existsSync(absPath)) return null;
  return JSON.parse(readFileSync(absPath, 'utf8'));
}

function buildArtifactCatalog(engineRoot) {
  const artifacts = {};
  for (const [name, relPath] of Object.entries(V12_DEBUG_ARTIFACTS)) {
    const absPath = resolve(engineRoot, relPath);
    artifacts[name] = {
      name,
      relative_path: relPath,
      absolute_path: absPath,
      exists: existsSync(absPath),
    };
  }
  return artifacts;
}

function relativePath(engineRoot, absPath) {
  return relative(engineRoot, absPath).split('\\').join('/');
}

function shouldExcludeLegacyPath(engineRoot, absPath) {
  const rel = relativePath(engineRoot, absPath);
  const segments = rel.split('/').filter(Boolean);
  return segments.some(segment => EXCLUDED_SEGMENT_PATTERNS.some(pattern => pattern.test(segment)));
}

function walkFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        files.push(absPath);
      }
    }
  }
  return files;
}

function readLegacyJsonlFile(engineRoot, absPath) {
  const text = readFileSync(absPath, 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const items = [];
  for (let index = 0; index < lines.length; index += 1) {
    const record = JSON.parse(lines[index]);
    if (!record || typeof record.verification_hash !== 'string') continue;
    items.push({
      source_path: relativePath(engineRoot, absPath),
      line_number: index + 1,
      verification_hash: record.verification_hash,
      receipt_id: record.receipt_id || null,
      receipt_type: record.receipt_type || null,
      wallet: record.wallet || null,
      chain: record.chain || null,
      token_mint: record.token_mint || null,
      quote_mint: record.quote_mint || null,
      quote_symbol: record.quote_symbol || null,
      raw: record,
    });
  }
  return items;
}

export function scanLegacyReceiptInventory({
  engineRoot = DEFAULT_ENGINE_ROOT,
  includeExcluded = false,
} = {}) {
  const receiptsDir = resolve(engineRoot, 'data');
  const files = walkFiles(receiptsDir)
    .filter(file => file.toLowerCase().endsWith('receipts.jsonl'));

  const legacy = [];
  for (const absPath of files) {
    if (!includeExcluded && shouldExcludeLegacyPath(engineRoot, absPath)) continue;
    legacy.push(...readLegacyJsonlFile(engineRoot, absPath));
  }

  legacy.sort((a, b) => {
    if (a.source_path !== b.source_path) return a.source_path.localeCompare(b.source_path);
    return a.line_number - b.line_number;
  });

  return legacy;
}

export function scanV12ReceiptArtifacts({
  engineRoot = DEFAULT_ENGINE_ROOT,
} = {}) {
  const artifacts = buildArtifactCatalog(engineRoot);

  const receipts = normalizeArrayPayload(safeReadJson(artifacts.receipts.absolute_path));
  const verifyResults = normalizeArrayPayload(safeReadJson(artifacts.verify.absolute_path), 'results');
  const valuationContexts = normalizeArrayPayload(safeReadJson(artifacts.valuations.absolute_path), 'contexts');
  const imageArtifacts = normalizeArrayPayload(safeReadJson(artifacts.imageArtifacts.absolute_path), 'artifacts');
  const metadataEntries = normalizeArrayPayload(safeReadJson(artifacts.metadata.absolute_path), 'metadata');
  const uploadDryRunEntries = normalizeArrayPayload(safeReadJson(artifacts.uploadDryRun.absolute_path), 'entries');
  const uploadResultEntries = normalizeArrayPayload(safeReadJson(artifacts.uploadResults.absolute_path), 'results');
  const mintPlanEntries = normalizeArrayPayload(safeReadJson(artifacts.mintPlan.absolute_path), 'plans');
  const mintResultEntries = normalizeArrayPayload(safeReadJson(artifacts.mintResults.absolute_path), 'results');
  const proofSummaryEntries = normalizeArrayPayload(safeReadJson(artifacts.proofSummary.absolute_path), 'receipts');

  const receiptIdToHash = new Map();
  const receiptHashToReceipt = new Map();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.receipt_hash !== 'string') continue;
    receiptIdToHash.set(receipt.receipt_id, receipt.receipt_hash);
    receiptHashToReceipt.set(receipt.receipt_hash, receipt);
  }

  const verifyByHash = new Map();
  for (const result of verifyResults) {
    if (result?.receipt_hash) verifyByHash.set(result.receipt_hash, result);
  }

  const valuationByHash = new Map();
  for (const context of valuationContexts) {
    const receiptHash = receiptIdToHash.get(context?.receipt_id);
    if (receiptHash) valuationByHash.set(receiptHash, context);
  }

  const imageByHash = new Map();
  for (const artifact of imageArtifacts) {
    const receiptHash = receiptIdToHash.get(artifact?.receipt_id);
    if (receiptHash) imageByHash.set(receiptHash, artifact);
  }

  const metadataByHash = new Map();
  for (const metadata of metadataEntries) {
    const receiptHash = metadata?.properties?.receipt_hash || receiptIdToHash.get(metadata?.properties?.receipt_id);
    if (receiptHash) metadataByHash.set(receiptHash, metadata);
  }

  const uploadDryRunByHash = new Map();
  for (const entry of uploadDryRunEntries) {
    if (entry?.receipt_hash) uploadDryRunByHash.set(entry.receipt_hash, entry);
  }

  const uploadResultByHash = new Map();
  for (const entry of uploadResultEntries) {
    if (entry?.receipt_hash) uploadResultByHash.set(entry.receipt_hash, entry);
  }

  const mintPlanByHash = new Map();
  for (const plan of mintPlanEntries) {
    if (plan?.receipt_hash) mintPlanByHash.set(plan.receipt_hash, plan);
  }

  const mintResultByHash = new Map();
  for (const result of mintResultEntries) {
    if (result?.receipt_hash) mintResultByHash.set(result.receipt_hash, result);
  }

  const proofSummaryByHash = new Map();
  for (const entry of proofSummaryEntries) {
    if (entry?.receipt_hash) proofSummaryByHash.set(entry.receipt_hash, entry);
  }

  return {
    engine_root: engineRoot,
    artifacts,
    receipts,
    receiptHashToReceipt,
    verifyByHash,
    valuationByHash,
    imageByHash,
    metadataByHash,
    uploadDryRunByHash,
    uploadResultByHash,
    mintPlanByHash,
    mintResultByHash,
    proofSummaryByHash,
  };
}

export function scanInventorySources({
  engineRoot = DEFAULT_ENGINE_ROOT,
  includeLegacy = false,
  includeExcluded = false,
} = {}) {
  const v12 = scanV12ReceiptArtifacts({ engineRoot });
  return {
    engine_root: engineRoot,
    include_legacy: includeLegacy,
    include_excluded: includeExcluded,
    v12,
    legacy: includeLegacy
      ? scanLegacyReceiptInventory({ engineRoot, includeExcluded })
      : [],
  };
}
