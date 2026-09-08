import { assertExactFields, canonicalJson } from '../contract.mjs';

// One bounded canonical envelope followed by EOF. No operation selector, paths,
// timestamps, callbacks, readiness inputs or transaction bytes are channel fields.
// The supervisor supplies the already-composed agent port and pipe descriptors.
export async function serveSingleWigglesDecisionV1({ agent, input, output, timeout_ms }) {
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms < 1 || timeout_ms > 60000) throw Error('finite channel timeout required');
  let timer, result;
  const chunks = []; let size = 0;
  try {
    const deadline = performance.now() + timeout_ms;
    const bytes = await Promise.race([
      (async () => {
        for await (const chunk of input) {
          if (!Buffer.isBuffer(chunk) || (size += chunk.length) > 131072 || performance.now() >= deadline) {
            throw Error('bounded byte channel required');
          }
          chunks.push(Buffer.from(chunk));
        }
        if (size === 0 || performance.now() >= deadline) throw Error('empty or expired channel');
        return Buffer.concat(chunks);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        input.destroy(); reject(Error('channel timeout'));
      }, timeout_ms); }),
    ]);
    clearTimeout(timer);
    result = await agent.submitDecisionBytesV1(bytes);
    assertExactFields(result, ['status', 'episode_id', 'signed_intent_digest'], 'wiggles_agent_channel_result');
    if (!['REFUSED', 'SIGNED_INTENT_DURABLE'].includes(result.status)) throw Error('unknown channel result');
  } catch {
    // A failed delivery may have consumed authority or signed. Never describe it
    // as retryable, unconsumed, or definitely unsigned; preserve trusted storage.
    result = { status: 'NOT_SUCCESSFUL', recovery: 'SUPERVISOR_RECONCILIATION_ONLY_NO_REPLACEMENT' };
  } finally { clearTimeout(timer); input.destroy(); }
  await new Promise((resolve, reject) => output.write(Buffer.from(canonicalJson(result)), error => error ? reject(error) : resolve()));
  return result.status;
}
