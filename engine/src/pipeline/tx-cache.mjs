/**
 * Pipeline — Transaction Cache
 *
 * Persistent per-wallet transaction cache for Helius data.
 * Supports incremental fetch: only requests new transactions
 * since the last known signature.
 *
 * Storage: one JSON file per wallet in cacheDir.
 * Format: { wallet, latestSig, oldestSig, count, fetchedAt, transactions: [...] }
 *
 * Chain data is append-only: new txns have newer signatures.
 * Helius returns newest-first, so we prepend new batches.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { BASE_URL, PAGE_SIZE, RATE_DELAY_MS } from './constants.mjs';

// ═══════════════════════════════════════════════════════════════
// TransactionCache
// ═══════════════════════════════════════════════════════════════

export class TransactionCache {
  /**
   * @param {object} opts
   * @param {string} opts.cacheDir - Directory for disk persistence
   */
  constructor({ cacheDir }) {
    this._cacheDir = cacheDir;
    this._memory = new Map(); // wallet → { latestSig, oldestSig, transactions, fetchedAt }
    mkdirSync(cacheDir, { recursive: true });
  }

  /**
   * Get cached transactions for a wallet.
   * Returns null if no cache exists.
   *
   * @param {string} wallet
   * @returns {{ transactions: object[], latestSig: string, count: number, fetchedAt: string } | null}
   */
  get(wallet) {
    // Memory first
    if (this._memory.has(wallet)) return this._memory.get(wallet);

    // Disk fallback
    const diskPath = this._diskPath(wallet);
    if (!existsSync(diskPath)) return null;

    try {
      const data = JSON.parse(readFileSync(diskPath, 'utf-8'));
      if (data.wallet === wallet && Array.isArray(data.transactions)) {
        this._memory.set(wallet, data);
        return data;
      }
    } catch { /* corrupt file */ }
    return null;
  }

  /**
   * Fetch transactions with incremental caching.
   *
   * If cache exists: fetches only newer transactions (before the cached latestSig),
   * then prepends them to the cache.
   *
   * If no cache: full fetch up to maxTxns.
   *
   * @param {string} wallet
   * @param {string} apiKey - Helius API key
   * @param {object} opts - { maxTxns?, silent? }
   * @returns {Promise<{ transactions: object[], fromCache: number, fetched: number, total: number }>}
   */
  async fetchIncremental(wallet, apiKey, { maxTxns = 5000, silent = false } = {}) {
    const existing = this.get(wallet);

    if (!existing) {
      // Full fetch
      const txns = await this._fetchAll(wallet, apiKey, { maxTxns, silent });
      const entry = {
        wallet,
        latestSig: txns.length > 0 ? txns[0].signature : null,
        oldestSig: txns.length > 0 ? txns[txns.length - 1].signature : null,
        count: txns.length,
        fetchedAt: new Date().toISOString(),
        transactions: txns,
      };
      this._memory.set(wallet, entry);
      this._saveToDisk(wallet, entry);
      return { transactions: txns, fromCache: 0, fetched: txns.length, total: txns.length };
    }

    // Incremental: fetch only newer transactions
    // Helius returns newest-first. We fetch pages until we see an existing signature.
    const knownSigs = new Set(existing.transactions.map(t => t.signature));
    const newTxns = [];
    let beforeSig = null;
    let pageNum = 0;
    let hitExisting = false;

    while (newTxns.length < maxTxns) {
      pageNum++;
      const limit = Math.min(PAGE_SIZE, maxTxns - newTxns.length);
      let url = `${BASE_URL}/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=${limit}`;
      if (beforeSig) url += `&before-signature=${beforeSig}`;

      try {
        const res = await fetch(url);
        if (!res.ok) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;

        let stopIdx = -1;
        for (let i = 0; i < batch.length; i++) {
          if (knownSigs.has(batch[i].signature)) {
            stopIdx = i;
            break;
          }
        }

        if (stopIdx >= 0) {
          // Found overlap — take only the new ones
          newTxns.push(...batch.slice(0, stopIdx));
          hitExisting = true;
          break;
        }

        newTxns.push(...batch);
        beforeSig = batch[batch.length - 1].signature;
        if (batch.length < limit) break;
        await new Promise(r => setTimeout(r, RATE_DELAY_MS));
      } catch {
        break;
      }
    }

    if (!silent && newTxns.length > 0) {
      console.log(`  Incremental: ${newTxns.length} new txns (${existing.count} cached)`);
    } else if (!silent) {
      console.log(`  Cache hit: ${existing.count} txns (no new transactions)`);
    }

    // Merge: new txns go at the front (newest-first)
    const merged = [...newTxns, ...existing.transactions];
    const entry = {
      wallet,
      latestSig: merged.length > 0 ? merged[0].signature : null,
      oldestSig: merged.length > 0 ? merged[merged.length - 1].signature : null,
      count: merged.length,
      fetchedAt: new Date().toISOString(),
      transactions: merged,
    };
    this._memory.set(wallet, entry);
    this._saveToDisk(wallet, entry);

    return {
      transactions: merged,
      fromCache: existing.count,
      fetched: newTxns.length,
      total: merged.length,
    };
  }

  /**
   * Get cache stats for a wallet.
   */
  stats(wallet) {
    const entry = this.get(wallet);
    if (!entry) return null;
    return {
      count: entry.count,
      latestSig: entry.latestSig?.slice(0, 16),
      oldestSig: entry.oldestSig?.slice(0, 16),
      fetchedAt: entry.fetchedAt,
    };
  }

  /**
   * Clear cache for a wallet.
   */
  clear(wallet) {
    this._memory.delete(wallet);
    const diskPath = this._diskPath(wallet);
    try { if (existsSync(diskPath)) writeFileSync(diskPath, '{}'); } catch {}
  }

  // ── Private ──

  async _fetchAll(wallet, apiKey, { maxTxns, silent }) {
    const allTxns = [];
    let beforeSig = null;
    let pageNum = 0;

    while (allTxns.length < maxTxns) {
      pageNum++;
      const limit = Math.min(PAGE_SIZE, maxTxns - allTxns.length);
      let url = `${BASE_URL}/v0/addresses/${wallet}/transactions?api-key=${apiKey}&limit=${limit}`;
      if (beforeSig) url += `&before-signature=${beforeSig}`;

      try {
        const res = await fetch(url);
        if (!res.ok) break;
        const batch = await res.json();
        if (!Array.isArray(batch) || batch.length === 0) break;

        allTxns.push(...batch);
        beforeSig = batch[batch.length - 1].signature;
        if (!silent) process.stdout.write(`  Page ${pageNum}: ${allTxns.length} txns\r`);
        if (batch.length < limit) break;
        if (allTxns.length < maxTxns) await new Promise(r => setTimeout(r, RATE_DELAY_MS));
      } catch {
        break;
      }
    }
    if (!silent) console.log(`  Fetched: ${allTxns.length} transactions`);
    return allTxns;
  }

  _diskPath(wallet) {
    // Use first 16 chars of wallet to avoid filesystem issues
    return resolve(this._cacheDir, `txns_${wallet.slice(0, 16)}.json`);
  }

  _saveToDisk(wallet, entry) {
    try {
      writeFileSync(this._diskPath(wallet), JSON.stringify(entry));
    } catch { /* ignore write errors */ }
  }
}
