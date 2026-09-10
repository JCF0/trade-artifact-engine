import { pathToFileURL } from 'node:url';
import { canonicalJson, assertExactFields } from '../../src/verification-scope-v1-3/contract.mjs';
import { reconstructFinalEpisodeReleaseV1 } from '../../src/verification-scope-v1-3/final-proof-agent/final-episode-release-v1.mjs';
// Fixed argv consumed only by the separate custody sandbox. Import-safe.
export async function verifyPackageV1(request) {
  assertExactFields(request, ['root', 'expected_manifest_sha256', 'expected_evidence_kind'], 'private_verification_request');
  return reconstructFinalEpisodeReleaseV1(request);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || Buffer.byteLength(process.argv[2]) > 4096) throw Error();
    process.stdout.write(canonicalJson(await verifyPackageV1(JSON.parse(process.argv[2]))) + '\n');
  } catch { process.stderr.write('PRIVATE_VERIFIER_STOPPED\n'); process.exitCode = 1; }
}
