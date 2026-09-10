// Disposable inherited-FD probe only. Never selects a wallet or runtime factory.
import { validateDescriptorTableV1, descriptorChannelsV1 } from '../binding.mjs';
import { readEnvelopeV1, writeFrameV1 } from '../supervisor.mjs';
import { parseCanonicalV1 } from '../io.mjs';
try {
  validateDescriptorTableV1();
  const channels = descriptorChannelsV1();
  try {
    const bytes = await readEnvelopeV1(channels.acquisition, 300);
    const value = parseCanonicalV1(bytes);
    if (Object.keys(value).join(',') !== 'synthetic' || value.synthetic !== true) throw Error();
    await writeFrameV1(channels.result1, { status: 'FIXTURE_FD_ACCEPTED' });
  } finally { for (const stream of Object.values(channels)) stream.destroy(); }
} catch (error) { process.stderr.write(String(error.stack) + '\n'); process.stdout.write('FIXTURE_FD_REFUSED\n'); process.exitCode = 1; }
