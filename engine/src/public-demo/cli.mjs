#!/usr/bin/env node
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { buildPublicDemoBundle, writePublicDemoBundle } from './site-bundle.mjs';

function printUsage(stderr = process.stderr) {
  stderr.write('Usage: node engine/src/public-demo/cli.mjs --dry-run|--write [--out <dir>] [--force] [--engine-root <dir>] [--package-root <dir>] [--archive-root <dir>] [--economics-root <dir>] [--visibility unlisted|public] [--wallet-display truncated|redacted] [--source-revision <value>]\n');
}

export function parseArgs(argv) {
  const args = {
    dryRun: false,
    write: false,
    out: '',
    force: false,
    engineRoot: '',
    packageRoot: '',
    archiveRoot: '',
    economicsRoot: '',
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
    else if (arg === '--engine-root') {
      args.engineRoot = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--package-root') {
      args.packageRoot = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--archive-root') {
      args.archiveRoot = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--economics-root') {
      args.economicsRoot = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--visibility') {
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
  if (args.packageRoot && (!args.engineRoot || !args.archiveRoot || !args.economicsRoot)) {
    throw new Error('--package-root requires explicit --engine-root, --archive-root, and --economics-root');
  }
  return args;
}

function renderPlan(bundle, outRoot = '') {
  return [
    'Artifact v1.11 public demo bundle',
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

  const fail = error => {
    printUsage(stderr);
    stderr.write(`${error.message}\n`);
    return 1;
  };

  try {
    const args = parseArgs(argv);
    const engineRoot = args.engineRoot
      ? resolve(args.engineRoot)
      : env.TRADE_ARTIFACT_INVENTORY_ROOT
      ? resolve(env.TRADE_ARTIFACT_INVENTORY_ROOT)
      : DEFAULT_ENGINE_ROOT;
    const archiveRoot = resolve(args.archiveRoot || resolve(engineRoot, 'data/inventory/receipt-archive-v1'));
    const economicsRoot = resolve(args.economicsRoot || resolve(engineRoot, 'data/inventory/receipt-economics-v1'));
    const bundle = buildPublicDemoBundle({
      engineRoot,
      ...(args.packageRoot ? { packageRoot: resolve(args.packageRoot) } : {}),
      archiveRoot,
      economicsRoot,
      visibility: args.visibility,
      walletDisplayMode: args.walletDisplay,
      sourceRevision: args.sourceRevision || null,
    });

    const finish = resolvedBundle => {
      if (args.dryRun) {
        stdout.write(renderPlan(resolvedBundle));
        return 0;
      }

      const written = writePublicDemoBundle(resolvedBundle, {
        outRoot: args.out,
        force: args.force,
      });
      stdout.write(renderPlan(resolvedBundle, written.outRoot));
      stderr.write(`Wrote public demo bundle to ${written.outRoot}\n`);
      return 0;
    };

    return typeof bundle?.then === 'function'
      ? bundle.then(finish, fail)
      : finish(bundle);
  } catch (error) {
    return fail(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
