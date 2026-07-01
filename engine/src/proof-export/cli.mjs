#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { renderStaticProofPage } from './render-static-page.mjs';

export function printUsage(stderr = process.stderr) {
  stderr.write('Usage: node engine/src/proof-export/cli.mjs --receipt-hash <hash> (--stdout | --output <path>) [--title <text>]\n');
}

export function parseArgs(argv) {
  const args = {
    receiptHash: '',
    stdout: false,
    output: '',
    title: '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--receipt-hash') {
      args.receiptHash = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--stdout') {
      args.stdout = true;
    } else if (arg === '--output') {
      args.output = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--title') {
      args.title = argv[i + 1] || '';
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.receiptHash) throw new Error('--receipt-hash is required');
  if (!args.stdout && !args.output) throw new Error('Choose --stdout or --output <path>');
  if (args.stdout && args.output) throw new Error('Choose either --stdout or --output <path>, not both');
  return args;
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

    const receipt = getInventoryReceipt(args.receiptHash, {
      engineRoot,
      includeExcluded: false,
    });

    if (!receipt) {
      stderr.write(`No proof detail found for receipt_hash: ${args.receiptHash}\n`);
      return 1;
    }

    const proofDetail = buildProofDetailView(receipt);
    const html = renderStaticProofPage(proofDetail, {
      title: args.title || undefined,
    });

    if (args.stdout) {
      stdout.write(html);
    } else {
      const outputPath = resolve(args.output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, html, 'utf8');
      stderr.write(`Wrote static proof page to ${outputPath}\n`);
    }

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
