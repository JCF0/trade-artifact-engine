// Versioned complete-owner-round qualification entry; no production authority.
import { readFileSync, closeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { admitQualificationInputV1 } from './qualification-contract-v1.mjs';
import { createSession, loadExchange, put, LIMITS, MAXIMA, VERSION, RETRY_POLICY } from './bounded-owner-round-v1.mjs';
import { OWNER_ROUND_POLICY } from './owner-round-v1.mjs';
import { probe } from './probe-owner-round-v1.mjs';

// The local full-worker fixture may tighten limits; it cannot raise any ceiling.
export async function run({ limits = LIMITS } = {}) {
  let session;
  try {
    const input = JSON.parse(readFileSync('/public-input.json', 'utf8'));
    const context = admitQualificationInputV1(input);
    const deadline = JSON.parse(readFileSync('/outer-deadline.json', 'utf8'));
    if (Object.keys(deadline).join(',') !== 'work_deadline_monotonic'
      || !Number.isFinite(deadline.work_deadline_monotonic)) throw Error('QUALIFICATION_DEADLINE');
    put('/evidence', 'qualification-admission.json', context);
    put('/evidence', 'qualification-session-policy.json', { version: VERSION, policy: RETRY_POLICY,
      logical_maxima: MAXIMA, owner_round: OWNER_ROUND_POLICY });
    session = createSession(loadExchange(), '/evidence', deadline.work_deadline_monotonic * 1000, limits);
    const findings = await probe(session, '/evidence', context, context.setup_signatures);
    if (findings.simulation !== 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS') process.exitCode = 1;
  } catch {
    put('/evidence', 'worker-stop.json', { disposition: 'QUALIFICATION_INPUT_OR_EXECUTION_STOP',
      consumed: session?.snapshot().consumed ?? 0 });
    process.exitCode = 1;
  } finally {
    session?.close();
    try { closeSync(5); } catch { /* The private loader already closes FD 5. */ }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();

