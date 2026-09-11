// Qualification-only entry, launched after the custodian's frozen input/isolation gates.
// Never an approval, eligibility check, production launcher or authority-store client.
import { readFileSync, closeSync } from 'node:fs';
import { admitQualificationInputV1 } from './qualification-contract-v1.mjs';
import { createSession, loadExchange, put } from './bounded-successor.mjs';
import { probe } from './probe-successor.mjs';
let session;
try {
  const input = JSON.parse(readFileSync('/public-input.json', 'utf8'));
  const context = admitQualificationInputV1(input);
  put('/evidence', 'qualification-admission.json', context);
  session = createSession(loadExchange(), '/evidence');
  const findings = await probe(session, '/evidence', context, context.setup_signatures);
  if (findings.simulation !== 'OBSERVED_UNSIGNED_EXECUTION_SUCCESS') process.exitCode = 1;
} catch {
  put('/evidence', 'worker-stop.json', { disposition: 'QUALIFICATION_INPUT_OR_EXECUTION_STOP',
    consumed: session?.snapshot().consumed ?? 0 });
  process.exitCode = 1;
} finally {
  session?.close();
  try { closeSync(5); } catch { /* The accepted private loader already closes FD 5. */ }
}
