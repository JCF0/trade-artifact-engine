#!/usr/bin/env node
import assert from 'assert';
import http from 'http';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

const PREVIOUS_TRADE_ARTIFACT_TEST = process.env.TRADE_ARTIFACT_TEST;
process.env.TRADE_ARTIFACT_TEST = '1';

const ENGINE_ROOT = resolve('engine');
const ARCHIVE_ROOT = resolve(ENGINE_ROOT, 'data', 'inventory', 'receipt-archive-v1');
const MANIFEST_PATH = resolve(ENGINE_ROOT, 'samples', 'historical-receipt-board.manifest.json');
const REQUEST_TIMEOUT_MS = 3000;
const TOTAL_TIMEOUT_MS = 30000;
const REAL_HASHES = {
  JUP: '5fb5732d248af4e8f9214a3b074c3bf711a776e8445bf14eae735ddf02a0bbca',
  RAY: '4d33969c45a041837070dbc83730862325ff989772712aae285384d4570e4341',
};

let failures = 0;
let server = null;
const startedAt = Date.now();
const totalTimer = setTimeout(() => {
  console.error(`FAIL  v1.9 archive demo exceeded ${TOTAL_TIMEOUT_MS}ms total timeout`);
  reportOpenHandles('total_timeout');
  process.exit(124);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

function pass(message) {
  console.log(`PASS  ${message}`);
}

function fail(message, error = null) {
  failures += 1;
  console.error(`FAIL  ${message}${error ? `  ${error.message || error}` : ''}`);
  if (error?.stack) console.error(error.stack);
}

function listTree(root, current = root, output = []) {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stats = statSync(path);
    output.push({
      path: relative(root, path),
      isDirectory: stats.isDirectory(),
      size: stats.isFile() ? stats.size : null,
      mtimeMs: Math.trunc(stats.mtimeMs),
    });
    if (stats.isDirectory()) listTree(root, path, output);
  }
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

function diffTrees(before, after) {
  const beforeMap = new Map(before.map(entry => [entry.path, entry]));
  const afterMap = new Map(after.map(entry => [entry.path, entry]));
  const added = [...afterMap.keys()].filter(path => !beforeMap.has(path));
  const removed = [...beforeMap.keys()].filter(path => !afterMap.has(path));
  const changed = [...afterMap.keys()].filter(path => {
    const oldEntry = beforeMap.get(path);
    const nextEntry = afterMap.get(path);
    return oldEntry && (oldEntry.size !== nextEntry.size || oldEntry.mtimeMs !== nextEntry.mtimeMs);
  });
  return { added, removed, changed };
}

function parseBody(body, contentType) {
  if (contentType.includes('application/json')) return JSON.parse(body);
  return body;
}

function httpGet(port, path) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.get({ hostname: '127.0.0.1', port, path, timeout: REQUEST_TIMEOUT_MS }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        const contentType = res.headers['content-type'] || '';
        try {
          resolveRequest({
            path,
            status: res.statusCode,
            contentType,
            bodyLength: body.length,
            body: parseBody(body, contentType),
          });
        } catch (error) {
          rejectRequest(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request_timeout:${path}`)));
    req.on('error', rejectRequest);
  });
}

function safeAddress(handle) {
  try {
    return typeof handle.address === 'function' ? handle.address() : undefined;
  } catch {
    return null;
  }
}

function activeHandleSummary() {
  if (typeof process._getActiveHandles !== 'function') return [];
  return process._getActiveHandles().map(handle => ({
    type: handle.constructor?.name || typeof handle,
    destroyed: handle.destroyed,
    address: safeAddress(handle),
  }));
}

function reportOpenHandles(label) {
  console.error(JSON.stringify({ label, active_handles: activeHandleSummary() }, null, 2));
}

async function closeServer(listener) {
  if (!listener) return;
  if (typeof listener.closeIdleConnections === 'function') listener.closeIdleConnections();
  if (typeof listener.closeAllConnections === 'function') listener.closeAllConnections();
  await new Promise((resolveClose, rejectClose) => {
    const timer = setTimeout(() => rejectClose(new Error('server_close_timeout')), 3000);
    listener.close(error => {
      clearTimeout(timer);
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function assertCoverageObjectSafe(coverage) {
  const serialized = JSON.stringify(coverage).toLowerCase();
  assert.equal(coverage.coverage_statement_version, 'receipt_coverage_v1');
  assert.equal(coverage.scope.scope_type, 'receipt');
  assert.equal(coverage.valuation_basis.valuation_status, 'raw_quote');
  assert.equal(coverage.valuation_basis.usd_normalized, false);
  for (const forbidden of ['wallet_address', 'realized_pnl', 'pnl_pct', 'usd_value', 'usd_amount', 'upload_status', 'mint_status', 'transaction_signature', 'signing']) {
    assert.ok(!serialized.includes(forbidden), `coverage leaked forbidden field: ${forbidden}`);
  }
}

function assertNoDiagnosticPathLeak(diagnostics) {
  for (const diagnostic of diagnostics) {
    const value = String(diagnostic.path || '');
    assert.ok(!isAbsolute(value), `absolute diagnostic path: ${value}`);
    assert.ok(!/^[A-Za-z]:[\\/]/.test(value), `drive-root diagnostic path: ${value}`);
    assert.ok(!value.includes('\\Users\\'), `local Windows root diagnostic path: ${value}`);
    assert.ok(!value.includes('/Users/'), `local POSIX root diagnostic path: ${value}`);
  }
}

function findArchivedUnverifiedReceipt(snapshot, currentSnapshot) {
  const currentHashes = new Set(currentSnapshot.receipts.map(receipt => receipt.receipt_hash));
  return snapshot.receipts.find(receipt => !currentHashes.has(receipt.receipt_hash) && receipt.verification_status !== 'verified')
    || snapshot.receipts.find(receipt => receipt.verification_status !== 'verified');
}

try {
  const beforeTree = listTree(ENGINE_ROOT);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (...args) => {
    fetchCalls += 1;
    throw new Error(`Unexpected route fetch call: ${String(args[0])}`);
  };

  try {
    const [{ app }, inventoryModule, boardModule] = await Promise.all([
      import('./api/server.mjs'),
      import('./inventory/inventory.mjs'),
      import('./receipt-board/view-model.mjs'),
    ]);
    const { buildInventorySnapshot, getInventoryReceipt } = inventoryModule;
    const { buildReceiptBoardView } = boardModule;

    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const manifestHashes = (Array.isArray(manifest.entries) ? manifest.entries : [])
      .map(entry => entry?.receipt_hash)
      .filter(value => typeof value === 'string' && value.length > 0);
    assert.ok(manifestHashes.length >= 2, 'expected at least two tracked board manifest entries');
    for (const hash of Object.values(REAL_HASHES)) assert.ok(manifestHashes.includes(hash), `tracked manifest missing ${hash}`);
    pass('tracked manifest contains real JUP and RAY receipt hashes');

    const indexPath = join(ARCHIVE_ROOT, 'index.json');
    const archiveIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
    const indexHashes = archiveIndex.receipts.map(receipt => receipt.receipt_hash);
    assert.equal(archiveIndex.receipts.length, 66, 'expected real validation archive count of 66 receipts');
    assert.deepEqual(indexHashes, [...indexHashes].sort((a, b) => a.localeCompare(b)));
    for (const [label, hash] of Object.entries(REAL_HASHES)) {
      assert.ok(indexHashes.includes(hash), `archive index missing ${label}`);
      assert.ok(existsSync(join(ARCHIVE_ROOT, 'receipts', `${hash}.json`)), `archive bundle missing ${label}`);
    }
    pass('archive index contains 66 sorted receipts including JUP and RAY bundles');

    const snapshot = buildInventorySnapshot({ engineRoot: ENGINE_ROOT, includeArchive: true, includeLegacy: false, includeExcluded: false });
    const currentSnapshot = buildInventorySnapshot({ engineRoot: ENGINE_ROOT, includeArchive: false, includeLegacy: false, includeExcluded: false });
    assert.equal(snapshot.archive.diagnostics.length, 0, 'expected zero archive diagnostics');
    assertNoDiagnosticPathLeak(snapshot.archive.diagnostics);
    for (const [label, hash] of Object.entries(REAL_HASHES)) {
      const receipt = getInventoryReceipt(hash, { engineRoot: ENGINE_ROOT, includeArchive: true, includeExcluded: false });
      assert.ok(receipt, `${label} did not resolve from archive-enabled inventory`);
      assert.equal(receipt.verification_status, 'verified');
      assert.equal(receipt.receipt_type, 'closed_position');
      assert.equal(receipt.valuation_status, 'raw_quote');
    }
    pass('archive-enabled inventory resolves verified JUP and RAY with zero diagnostics');

    const unverified = findArchivedUnverifiedReceipt(snapshot, currentSnapshot);
    assert.ok(unverified, 'expected at least one unverified receipt in archive-enabled inventory');
    const unverifiedBoard = buildReceiptBoardView({
      engineRoot: ENGINE_ROOT,
      manifest: {
        ...manifest,
        entries: [{
          receipt_hash: unverified.receipt_hash,
          display_name: 'Unverified Archive Fixture',
          participant_ref: 'local-unverified-archive-fixture',
          selection_note: 'In-memory archive eligibility check.',
        }],
      },
    });
    assert.equal(unverifiedBoard.rows.length, 0);
    assert.equal(unverifiedBoard.excluded_entries[0].reason, 'verification_status_not_board_eligible');
    pass('archived unverified receipt remains board-ineligible');

    server = http.createServer(app);
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS + 1000;
    server.keepAliveTimeout = 500;
    await new Promise((resolveServer, rejectServer) => {
      server.listen(0, '127.0.0.1', () => resolveServer());
      server.on('error', rejectServer);
    });
    const port = server.address().port;

    const routeSummaries = [];
    for (const [label, hash] of Object.entries(REAL_HASHES)) {
      for (const route of [`/api/proof/${hash}`, `/api/verifier/${hash}`, `/api/proof/${hash}/card`, `/api/proof/${hash}/card/preview`, `/api/proof/${hash}/export`, `/api/proof/${hash}/hosted-preview`]) {
        const response = await httpGet(port, route);
        const expectedType = route.endsWith('/card/preview') || route.endsWith('/export') || route.endsWith('/hosted-preview') ? 'text/html' : 'application/json';
        assert.equal(response.status, 200, `${route} status`);
        assert.ok(response.contentType.includes(expectedType), `${route} content-type ${response.contentType}`);
        if (route === `/api/proof/${hash}`) assertCoverageObjectSafe(response.body.coverage_statement);
        if (route === `/api/verifier/${hash}`) assertCoverageObjectSafe(response.body.coverage_statement);
        routeSummaries.push(`${label} ${route.replace(hash, '<hash>')} status=${response.status} type=${expectedType}`);
      }
    }
    pass(`proof surfaces resolved for both selected hashes (${routeSummaries.length} route checks)`);

    const boardJson = await httpGet(port, '/api/receipt-board');
    const boardPreview = await httpGet(port, '/api/receipt-board/preview');
    assert.equal(boardJson.status, 200);
    assert.equal(boardPreview.status, 200);
    assert.ok(boardPreview.contentType.includes('text/html'));
    const boardRowsByHash = new Map(boardJson.body.rows.map(row => [row.receipt_hash, row]));
    for (const hash of Object.values(REAL_HASHES)) {
      const row = boardRowsByHash.get(hash);
      assert.ok(row, `board row missing ${hash}`);
      assert.equal(row.verification_status, 'verified');
      assert.equal(row.receipt_type, 'closed_position');
      assert.equal(row.valuation_status, 'raw_quote');
      assert.equal(row.coverage_statement.publication_context.surface, 'historical_receipt_board');
      assert.equal(row.coverage_statement.publication_context.selection_mode, 'publisher_selected');
      assertCoverageObjectSafe(row.coverage_statement);
    }
    assert.equal(boardJson.body.ranking.metric, 'trust_then_time');
    assert.equal(boardJson.body.ranking.rank_subject, 'receipt');
    assert.equal(boardJson.body.ranking.pnl_scope, 'none');
    assert.equal(boardJson.body.selection_scope.mode, 'publisher_selected');
    assert.ok(boardPreview.body.includes('Publisher-selected board entry.'));
    pass(`receipt board returned both verified rows (${boardJson.body.rows.length} rows)`);

    const inventoryApi = await httpGet(port, '/api/inventory');
    const directArchivedJup = await httpGet(port, `/inventory/${REAL_HASHES.JUP}`);
    assert.equal(inventoryApi.status, 200);
    assert.equal(inventoryApi.body.counts.receipts, currentSnapshot.counts.receipts);
    assert.equal(Object.hasOwn(inventoryApi.body, 'archive'), false);
    assert.equal(directArchivedJup.status, 404);
    pass('default inventory remains current-snapshot-only and archived-only JUP stays 404 through /inventory/:hash');

    const afterTree = listTree(ENGINE_ROOT);
    const diff = diffTrees(beforeTree, afterTree);
    assert.deepEqual(diff, { added: [], removed: [], changed: [] });
    assert.equal(fetchCalls, 0);
    pass('filesystem unchanged and zero route-internal fetch calls observed');
  } finally {
    await closeServer(server);
    server = null;
    globalThis.fetch = originalFetch;
  }

  await new Promise(resolvePause => setTimeout(resolvePause, 100));
  const serverHandles = activeHandleSummary().filter(handle => handle.type === 'Server' && handle.address !== null);
  assert.equal(serverHandles.length, 0, 'lingering listening server handle detected');
  pass('server closed with no lingering listener handle');
} catch (error) {
  fail('v1.9 archive demo assertion failed', error);
} finally {
  clearTimeout(totalTimer);
  if (server) {
    try {
      await closeServer(server);
    } catch (error) {
      fail('server cleanup failed', error);
    }
  }
  if (PREVIOUS_TRADE_ARTIFACT_TEST === undefined) delete process.env.TRADE_ARTIFACT_TEST;
  else process.env.TRADE_ARTIFACT_TEST = PREVIOUS_TRADE_ARTIFACT_TEST;
}

console.log(`Archive demo elapsed_ms: ${Date.now() - startedAt}`);
console.log(`Result: ${failures === 0 ? 'PASS' : 'FAIL'}`);
process.exit(failures > 0 ? 1 : 0);
