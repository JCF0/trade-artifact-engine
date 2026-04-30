/**
 * Pipeline — Token Metadata Resolver
 *
 * Resolves symbol, name, decimals, and logo for Solana token mints.
 *
 * Strategy:
 *   1. Check in-memory cache (instant)
 *   2. Check built-in known tokens (SOL, USDC, USDT — zero API cost)
 *   3. Batch-fetch via Helius DAS getAssetBatch (single API call for all unknown mints)
 *   4. Unknown tokens get a fallback entry with truncated mint as symbol
 *
 * Cache is per-session in-memory + optional disk persistence.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { SOL_MINT, USDC_MINT, USDT_MINT } from './constants.mjs';

// ═══════════════════════════════════════════════════════════════
// Built-in known tokens (zero API cost)
// ═══════════════════════════════════════════════════════════════

const KNOWN_TOKENS = new Map([
  [SOL_MINT, {
    mint: SOL_MINT, symbol: 'SOL', name: 'Solana', decimals: 9,
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
    source: 'built-in',
  }],
  [USDC_MINT, {
    mint: USDC_MINT, symbol: 'USDC', name: 'USD Coin', decimals: 6,
    logo: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
    source: 'built-in',
  }],
  [USDT_MINT, {
    mint: USDT_MINT, symbol: 'USDT', name: 'Tether USD', decimals: 6,
    logo: null,
    source: 'built-in',
  }],
]);

// ═══════════════════════════════════════════════════════════════
// TokenMetadataCache
// ═══════════════════════════════════════════════════════════════

export class TokenMetadataCache {
  /**
   * @param {object} opts
   * @param {string} [opts.heliusApiKey] - Helius API key for DAS calls
   * @param {string} [opts.cacheDir] - Directory for disk persistence (optional)
   */
  constructor({ heliusApiKey, cacheDir } = {}) {
    this._cache = new Map(KNOWN_TOKENS);
    this._heliusApiKey = heliusApiKey || '';
    this._cacheDir = cacheDir || null;
    this._diskPath = cacheDir ? resolve(cacheDir, 'token-metadata.json') : null;
    this._loadFromDisk();
  }

  /**
   * Get metadata for a single mint. Returns cached entry or null.
   * Does NOT trigger API calls — use resolve() for that.
   */
  get(mint) {
    return this._cache.get(mint) || null;
  }

  /**
   * Get metadata for a single mint, resolving via API if needed.
   */
  async getOrResolve(mint) {
    const cached = this._cache.get(mint);
    if (cached) return cached;
    await this.resolve([mint]);
    return this._cache.get(mint) || this._makeFallback(mint);
  }

  /**
   * Resolve metadata for a list of mints.
   * Only fetches mints not already in cache.
   * Uses Helius DAS getAssetBatch (max 1000 per call).
   *
   * @param {string[]} mints - Mint addresses to resolve
   * @returns {Promise<Map<string, object>>} Resolved entries
   */
  async resolve(mints) {
    const unknown = mints.filter(m => !this._cache.has(m));
    if (unknown.length === 0) return this._cache;

    if (this._heliusApiKey) {
      // Batch in groups of 100 (DAS limit)
      for (let i = 0; i < unknown.length; i += 100) {
        const batch = unknown.slice(i, i + 100);
        await this._fetchHeliusBatch(batch);
      }
    }

    // Any still-unknown mints get fallback entries
    for (const mint of unknown) {
      if (!this._cache.has(mint)) {
        this._cache.set(mint, this._makeFallback(mint));
      }
    }

    this._saveToDisk();
    return this._cache;
  }

  /**
   * Get all cached entries as a plain object (for serialization).
   */
  toJSON() {
    const obj = {};
    for (const [mint, meta] of this._cache) {
      obj[mint] = meta;
    }
    return obj;
  }

  /**
   * Get the number of cached entries.
   */
  get size() {
    return this._cache.size;
  }

  /**
   * Get stats about the cache.
   */
  get stats() {
    let builtIn = 0, helius = 0, fallback = 0;
    for (const meta of this._cache.values()) {
      if (meta.source === 'built-in') builtIn++;
      else if (meta.source === 'helius-das') helius++;
      else fallback++;
    }
    return { total: this._cache.size, builtIn, helius, fallback };
  }

  // ── Private ──

  async _fetchHeliusBatch(mints) {
    try {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${this._heliusApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getAssetBatch',
          params: { ids: mints },
        }),
      });

      if (!res.ok) return;
      const data = await res.json();
      if (!data.result || !Array.isArray(data.result)) return;

      for (const asset of data.result) {
        if (!asset || !asset.id) continue;
        const mint = asset.id;
        const meta = asset.content?.metadata || {};
        const tokenInfo = asset.token_info || {};

        this._cache.set(mint, {
          mint,
          symbol: meta.symbol || mint.slice(0, 6),
          name: meta.name || 'Unknown Token',
          decimals: tokenInfo.decimals ?? null,
          logo: asset.content?.links?.image || asset.content?.files?.[0]?.uri || null,
          source: 'helius-das',
        });
      }
    } catch {
      // Silently fail — fallback entries will be created
    }
  }

  _makeFallback(mint) {
    return {
      mint,
      symbol: mint.slice(0, 6),
      name: 'Unknown Token',
      decimals: null,
      logo: null,
      source: 'fallback',
    };
  }

  _loadFromDisk() {
    if (!this._diskPath || !existsSync(this._diskPath)) return;
    try {
      const data = JSON.parse(readFileSync(this._diskPath, 'utf-8'));
      for (const [mint, meta] of Object.entries(data)) {
        if (!this._cache.has(mint)) {
          this._cache.set(mint, meta);
        }
      }
    } catch { /* ignore corrupt cache */ }
  }

  _saveToDisk() {
    if (!this._diskPath) return;
    try {
      const dir = resolve(this._diskPath, '..');
      mkdirSync(dir, { recursive: true });
      writeFileSync(this._diskPath, JSON.stringify(this.toJSON(), null, 2));
    } catch { /* ignore write errors */ }
  }
}

// ═══════════════════════════════════════════════════════════════
// collectMints — extract all unique mints from pipeline data
// ═══════════════════════════════════════════════════════════════

/**
 * Collect all unique token mints from normalized events.
 * @param {object[]} events - Normalized swap events
 * @returns {string[]} Unique mint addresses
 */
export function collectMints(events) {
  const mints = new Set();
  for (const ev of events) {
    if (ev.token_in_mint) mints.add(ev.token_in_mint);
    if (ev.token_out_mint) mints.add(ev.token_out_mint);
  }
  return [...mints];
}

/**
 * Collect all unique token mints from positions.
 * @param {object[]} positions
 * @returns {string[]}
 */
export function collectMintsFromPositions(positions) {
  const mints = new Set();
  for (const p of positions) {
    if (p.token) mints.add(p.token);
    for (const leg of (p.legs || [])) {
      if (leg.quote_mint) mints.add(leg.quote_mint);
      if (leg.raw_quote_mint) mints.add(leg.raw_quote_mint);
    }
  }
  return [...mints];
}

// ═══════════════════════════════════════════════════════════════
// enrichPositions — attach metadata to positions and legs
// ═══════════════════════════════════════════════════════════════

/**
 * Enrich positions with token metadata.
 * Adds token_meta to each position and quote_meta to each leg.
 *
 * @param {object[]} positions
 * @param {TokenMetadataCache} cache
 * @returns {object[]} Enriched positions (mutates in place for efficiency)
 */
export function enrichPositions(positions, cache) {
  for (const p of positions) {
    const tokenMeta = cache.get(p.token);
    if (tokenMeta) {
      p.token_meta = {
        symbol: tokenMeta.symbol,
        name: tokenMeta.name,
        decimals: tokenMeta.decimals,
        logo: tokenMeta.logo,
      };
    }

    for (const leg of (p.legs || [])) {
      const qMint = leg.raw_quote_mint || leg.quote_mint;
      if (qMint) {
        const qMeta = cache.get(qMint);
        if (qMeta) {
          leg.quote_meta = { symbol: qMeta.symbol, name: qMeta.name };
        }
      }
    }
  }
  return positions;
}
