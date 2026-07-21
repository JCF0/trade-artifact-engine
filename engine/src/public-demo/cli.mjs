#!/usr/bin/env node
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { buildPublicDemoBundle, writePublicDemoBundle } from './site-bundle.mjs';

function printUsage(stderr = process.stderr) {
  stderr.write('Usage: node engine/src/public-demo/cli.mjs --dry-run|--write [--out <dir>] [--force] [--visibility unlisted|public] [--wallet-display truncated|redacted] [--source-revision <value>]\n');
}

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    write: false,
    out: '',
    force: false,
    visibility: 'unlisted',
    walletDisplay: 'truncated',
    sourceRevision: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--write') args.write = true;
    else if (arg === '--out') {
      args.out = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--force') args.force = true;
    else if (arg === '--visibility') {
      args.visibility = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--wallet-display') {
      args.walletDisplay = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--source-revision') {
      args.sourceRevision = argv[i + 1] || '';
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.dryRun === args.write) throw new Error('exactly one of --dry-run or --write is required');
  if (args.write && !args.out) throw new Error('--out is required with --write');
  if (args.walletDisplay === 'full') throw new Error('full wallet display is not allowed for public demo builds');
  return args;
}

function renderPlan(bundle, outRoot = '') {
  return [
    'Artifact v1.10 public demo bundle',
    `mode: ${outRoot ? 'write' : 'dry-run'}`,
    `out: ${outRoot || '(none)'}`,
    `files: ${bundle.fileList.length}`,
    ...bundle.fileList.map(file => `- ${file}`),
    `leak_check: ${bundle.leakCheck.ok ? 'pass' : 'fail'}`,
    '',
  ].join('\n');
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  try {
    const args = parseArgs(argv);
    const engineRoot = env.TRADE_ARTIFACT_INVENTORY_ROOT
      ? resolve(env.TRADE_ARTIFACT_INVENTORY_ROOT)
      : DEFAULT_ENGINE_ROOT;
    const bundle = buildPublicDemoBundle({
      engineRoot,
      visibility: args.visibility,
      walletDisplayMode: args.walletDisplay,
      sourceRevision: args.sourceRevision || null,
    });

    if (args.dryRun) {
      stdout.write(renderPlan(bundle));
      return 0;
    }

    const written = writePublicDemoBundle(bundle, {
      outRoot: args.out,
      force: args.force,
    });
    stdout.write(renderPlan(bundle, written.outRoot));
    stderr.write(`Wrote public demo bundle to ${written.outRoot}\n`);
    return 0;
  } catch (error) {
    printUsage(stderr);
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runCli(process.argv.slice(2)));
}
