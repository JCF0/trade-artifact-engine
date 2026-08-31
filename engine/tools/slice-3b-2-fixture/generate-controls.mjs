#!/usr/bin/env node

import { lstat, open, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Keypair } from '@solana/web3.js';

import { FixtureSetupError } from './fixture-core.mjs';

const PUBLIC_CONTROLS_VERSION = 'artifact_slice_3b_2_public_controls_v1';
const LOCAL_MACHINE_ATTESTATION = 'I_CONFIRM_THIS_IS_A_TRUSTED_LOCAL_MACHINE_NOT_THE_ARTIFACT_VPS';

function fail(code) {
  throw new FixtureSetupError(code);
}

async function gitWorktreeAncestor(path) {
  let current = path;
  for (;;) {
    try {
      await lstat(join(current, '.git'));
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function assertSafeLocalSecretPath(path, attestation) {
  if (attestation !== LOCAL_MACHINE_ATTESTATION) fail('trusted_local_machine_not_attested');
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('local_secret_path_unsafe');
  const parent = dirname(path);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    fail('local_secret_parent_unavailable');
  }
  if (canonicalParent !== parent) fail('local_secret_parent_not_canonical');
  if (await gitWorktreeAncestor(parent)) fail('secret_path_inside_git_worktree');
  return path;
}

async function writeExclusive(path, text, mode) {
  let handle;
  try {
    handle = await open(path, 'wx', mode);
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } catch (error) {
    if (error?.code === 'EEXIST') fail('output_path_unavailable');
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function generateControlFiles(input, dependencies = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
      || typeof input.secret_dir !== 'string' || !isAbsolute(input.secret_dir)
      || typeof input.public_output !== 'string' || !isAbsolute(input.public_output)) {
    fail('local_control_paths_invalid');
  }
  const secretDir = resolve(input.secret_dir);
  const publicOutput = resolve(input.public_output);
  if (publicOutput === secretDir || publicOutput.startsWith(`${secretDir}${sep}`)) fail('public_output_inside_secret_directory');
  await assertSafeLocalSecretPath(secretDir, input.local_machine_attestation);
  await assertSafeLocalSecretPath(publicOutput, input.local_machine_attestation);

  try {
    await mkdir(secretDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('secret_directory_unavailable');
    throw error;
  }
  const canonicalSecretDir = await realpath(secretDir);
  if (canonicalSecretDir !== secretDir) fail('secret_directory_path_not_canonical');

  const createKeypair = dependencies.createKeypair ?? (() => Keypair.generate());
  const empty = createKeypair();
  const known = createKeypair();
  if (!(empty instanceof Keypair) || !(known instanceof Keypair)
      || empty.publicKey.equals(known.publicKey)) fail('generated_control_keypairs_invalid');

  const publicControls = {
    fixture_controls_version: PUBLIC_CONTROLS_VERSION,
    empty_control_wallet: empty.publicKey.toBase58(),
    known_control_wallet: known.publicKey.toBase58(),
  };
  try {
    await writeExclusive(
      `${secretDir}${sep}empty-control.keypair.json`,
      `${JSON.stringify([...empty.secretKey])}\n`,
      0o600,
    );
    await writeExclusive(
      `${secretDir}${sep}known-control.keypair.json`,
      `${JSON.stringify([...known.secretKey])}\n`,
      0o600,
    );
    await writeExclusive(publicOutput, `${JSON.stringify(publicControls, null, 2)}\n`, 0o600);

    return Object.freeze({
      empty_control_wallet: publicControls.empty_control_wallet,
      known_control_wallet: publicControls.known_control_wallet,
      public_output: publicOutput,
    });
  } finally {
    empty.secretKey.fill(0);
    known.secretKey.fill(0);
  }
}

function parseArguments(argv) {
  if (argv[0] !== '--generate-local-controls') fail('local_control_generation_not_authorized');
  const allowed = new Set(['--secret-dir', '--public-output', '--local-machine-attestation']);
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || value.length === 0 || values[key] !== undefined) {
      fail('local_control_arguments_invalid');
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) fail('local_control_arguments_invalid');
  return {
    secret_dir: values['--secret-dir'],
    public_output: values['--public-output'],
    local_machine_attestation: values['--local-machine-attestation'],
  };
}

async function main(argv) {
  try {
    const result = await generateControlFiles(parseArguments(argv));
    process.stdout.write(`${JSON.stringify({
      empty_control_wallet: result.empty_control_wallet,
      known_control_wallet: result.known_control_wallet,
      public_output: result.public_output,
    }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof FixtureSetupError ? error.code : 'local_control_generation_failed';
    process.stderr.write(`${code}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
