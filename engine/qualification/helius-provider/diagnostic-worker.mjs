// One diagnostic exchange only; no qualification probe or construction import.
import { closeSync } from 'node:fs';
import { createSession, loadExchange, put, LIMITS } from './diagnostic-bounded.mjs';
import { observe } from './diagnostic-stages.mjs';
let session;
try {
  observe('WORKER_STARTED');
  const exchange = loadExchange();
  observe('CAPABILITY_LOADED');
  session = createSession(exchange, '/evidence', { ...LIMITS, calls: 1 }, { getGenesisHash: 1 });
  const genesis = await session.call('getGenesisHash', []);
  observe('ADMITTED', 'NONE', genesis === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' ? 1 : 0);
} catch {
  observe('WORKER_STOP');
  process.exitCode = 1;
} finally {
  session?.close();
  put('/evidence', 'diagnostic-ledger.json', session?.snapshot() ?? { consumed: 0, closed: true });
  try { closeSync(5); } catch { /* Accepted loader closes the capability. */ }
}
