/**
 * Irys Uploader Adapter — E7
 *
 * Implements E6's injected uploader interface using the Irys SDK.
 * Irys SDK is lazily imported — only when createIrysUploader is called.
 *
 * This module does NOT:
 *   - Print .env contents, private keys, or keypair arrays
 *   - Print process.env or full Irys config objects
 *   - Store secrets in output manifests
 *   - Mint anything on-chain
 *   - Submit Solana mint transactions
 *   - Change v1.1 upload/mint behavior
 *   - Modify receipt schemas, hashes, or verifier logic
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

const GATEWAY_BASE = 'https://gateway.irys.xyz';
const DEFAULT_RPC = 'https://api.devnet.solana.com';

// ═══════════════════════════════════════════════════════════════
// Safe env presence checks (pure — no secret values returned)
// ═══════════════════════════════════════════════════════════════

/**
 * Check env var presence without returning secret values.
 * @returns {object} Presence flags only
 */
export function checkEnvPresence() {
  return {
    uploadEnabled: process.env.UPLOAD_ENABLED === 'true',
    keypairPathDefined: !!process.env.IRYS_KEYPAIR_PATH,
    // Never return the actual path — just presence
    keypairPathPresence: process.env.IRYS_KEYPAIR_PATH ? 'defined' : 'not defined',
    rpcUrlDefined: !!process.env.IRYS_RPC_URL,
    networkOverride: process.env.IRYS_NETWORK || null,
  };
}

/**
 * Check if keypair file exists at the configured path.
 * @returns {boolean}
 */
export function keypairFileExists() {
  const kp = process.env.IRYS_KEYPAIR_PATH;
  if (!kp) return false;
  return existsSync(resolve(kp));
}

// ═══════════════════════════════════════════════════════════════
// Receipt selection helpers (pure)
// ═══════════════════════════════════════════════════════════════

/**
 * Select packages for upload based on CLI constraints.
 * @param {object[]} packages - All upload packages
 * @param {object} opts
 * @param {string|null} opts.uploadReceiptId
 * @param {number|null} opts.uploadMax
 * @returns {{ selected: object[], reason: string }}
 */
export function selectPackages(packages, opts = {}) {
  if (opts.uploadReceiptId) {
    const selected = packages.filter(p => p.receipt_id === opts.uploadReceiptId);
    return {
      selected,
      reason: selected.length > 0
        ? `receipt_id: ${opts.uploadReceiptId}`
        : `no package found for receipt_id: ${opts.uploadReceiptId}`,
    };
  }
  if (opts.uploadMax != null && opts.uploadMax > 0) {
    return {
      selected: packages.slice(0, opts.uploadMax),
      reason: `upload_max: ${opts.uploadMax}`,
    };
  }
  return { selected: [], reason: 'no receipt limit set' };
}

// ═══════════════════════════════════════════════════════════════
// Irys adapter factory (lazy SDK import)
// ═══════════════════════════════════════════════════════════════

/**
 * Create a real Irys uploader that implements E6's interface:
 *   uploader.uploadFile(pathOrMarker, opts) → Promise<{ id }>
 *
 * Irys SDK is dynamically imported here — not at module top level.
 * Keypair bytes are loaded internally and NEVER logged or returned.
 *
 * @param {object} opts
 * @param {string} opts.keypairPath - Absolute path to keypair JSON file
 * @param {string} [opts.rpcUrl] - Solana RPC URL (default: devnet)
 * @param {boolean} [opts.devnet=true] - Use devnet
 * @returns {Promise<{ uploadFile, address, close }>}
 */
export async function createIrysUploader(opts) {
  const { keypairPath, rpcUrl, devnet = true } = opts;

  if (!keypairPath || !existsSync(resolve(keypairPath))) {
    throw new Error('Keypair file not found (path checked, not logged)');
  }

  // Lazy import — only when actually creating an uploader
  const { Uploader } = await import('@irys/upload');
  const { Solana } = await import('@irys/upload-solana');

  // Load keypair internally — NEVER log or return the bytes
  const keypairBytes = JSON.parse(readFileSync(resolve(keypairPath), 'utf-8'));

  let builder = Uploader(Solana)
    .withWallet(Buffer.from(keypairBytes))
    .withRpc(rpcUrl || DEFAULT_RPC);

  if (devnet) builder = builder.devnet();

  const irys = await builder;

  // Derive public address (safe to log)
  const address = irys.address || '(unknown)';

  // Temp file counter for metadata uploads
  let tempCounter = 0;

  return {
    address,

    /**
     * Upload a file or JSON content to Irys.
     *
     * If opts.content is provided, writes to temp file, uploads, deletes temp.
     * Otherwise uploads the file at localPath directly.
     *
     * @param {string} localPath - File path (or marker for content uploads)
     * @param {object} uploadOpts - { tags, content? }
     * @returns {Promise<{ id: string }>}
     */
    async uploadFile(localPath, uploadOpts = {}) {
      const tags = uploadOpts.tags || [];

      if (uploadOpts.content) {
        // Metadata JSON upload via temp file
        tempCounter++;
        const tmpPath = resolve(process.cwd(), `_tmp_v12_upload_${tempCounter}_${Date.now()}.json`);
        try {
          writeFileSync(tmpPath, uploadOpts.content);
          const result = await irys.uploadFile(tmpPath, { tags });
          return { id: result.id };
        } finally {
          try { unlinkSync(tmpPath); } catch {}
        }
      }

      // Direct file upload
      const absPath = resolve(localPath);
      if (!existsSync(absPath)) {
        throw new Error(`Upload file not found: ${localPath}`);
      }
      const result = await irys.uploadFile(absPath, { tags });
      return { id: result.id };
    },

    close() {
      // No-op for now — Irys SDK doesn't require explicit cleanup
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Existing results loader (for idempotency — correction 1)
// ═══════════════════════════════════════════════════════════════

/**
 * Load existing upload results manifest and index by receipt_id.
 * Returns empty map if file doesn't exist or is invalid.
 *
 * @param {string} manifestPath - Absolute path to results manifest
 * @returns {Map<string, object>}
 */
export function loadExistingResults(manifestPath) {
  const map = new Map();
  try {
    if (!existsSync(manifestPath)) return map;
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (Array.isArray(raw.results)) {
      for (const r of raw.results) {
        if (r.receipt_id) map.set(r.receipt_id, r);
      }
    }
  } catch {
    // Corrupt file — start fresh but don't crash
  }
  return map;
}

/**
 * Merge new results into existing results map, then serialize.
 * Preserves prior results for receipt_ids not in the current upload batch.
 *
 * @param {Map<string, object>} existingMap
 * @param {object[]} newResults
 * @returns {object[]} Merged results array
 */
export function mergeResults(existingMap, newResults) {
  const merged = new Map(existingMap);
  for (const r of newResults) {
    merged.set(r.receipt_id, r);
  }
  return [...merged.values()];
}
