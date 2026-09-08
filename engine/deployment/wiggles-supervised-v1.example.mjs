// Administrator-owned PROPOSAL, not installed, approved, or executable authority.
// Deliberate nulls: no production identities, budget, mandate or release invented.
export const WIGGLES_CONFIGURATION_TEMPLATE_V1 = Object.freeze({
  mandate: null,
  authorization: null,
  executor_release_sha256: null,
  expected_wallet: '5CJdSbz9d5CifzFcWL5NcbicgpSAEuDGpSZBgaLHN1tA',
  wallet_key_path: '/var/lib/artifact-wiggles/key/wallet.json',
  state_root: '/var/lib/artifact-wiggles/episode',
  budget: null,
  deadline_unix_seconds: null,
});
export const WIGGLES_LAUNCH_PROPOSAL_V1 = Object.freeze({
  executable: '/usr/bin/node',
  argv: Object.freeze(['/opt/artifact/release/engine/src/verification-scope-v1-3/final-proof-agent/run-wiggles-supervised-v1.mjs']),
  cwd: '/opt/artifact/release',
  environment: Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/nonexistent', NODE_OPTIONS: '', NODE_PATH: '' }),
  runtime_identity: 'artifact-wiggles',
  controller_identity: 'artifact-hermes',
  provisioner_identity: 'root',
  umask: '0077',
  restart: 'NEVER_AUTOMATIC',
  channel: 'SUPERVISOR_OWNED_ONE_ENVELOPE_PIPE_THEN_EOF',
  channel_timeout_ms: 30000,
  release_status: 'MECHANICALLY_DISABLED_NO_ENABLE_FLAG',
});
