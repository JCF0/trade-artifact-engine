import { pathToFileURL } from 'node:url';
import { openDisabledPrivateBindingV1, descriptorChannelsV1 } from './binding.mjs';
import { runFiniteEpisodeV1 } from './supervisor.mjs';
// New candidate executable is mechanically disabled too. No CLI selectors,
// environment enable flag, runtime import path, or alternate production opener.
export async function candidateWorkerV1() {
  if (process.argv.length !== 2 || process.execArgv.some(v => !v.startsWith('--openssl-config='))
    || Object.keys(process.env).some(k => !['PATH', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ'].includes(k))) throw Error('PRIVATE_WORKER_STOPPED');
  const binding = openDisabledPrivateBindingV1(); // unconditionally stops before private effects
  const channels = descriptorChannelsV1();
  try { return await runFiniteEpisodeV1({ ...binding, channels }); }
  finally { binding.close(); for (const channel of Object.values(channels)) channel.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await candidateWorkerV1(); }
  catch { process.stderr.write('PRIVATE_WORKER_STOPPED_NO_REPLACEMENT\n'); process.exitCode = 1; }
}
