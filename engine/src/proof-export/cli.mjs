#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { pathToFileURL } from 'url';
import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { resolveReceiptProofSourceV1 } from '../proof-source/package-native-proof-source.mjs';
import { renderStaticProofPage } from './render-static-page.mjs';

export function printUsage(stderr = process.stderr) {
  stderr.write('Usage: node engine/src/proof-export/cli.mjs --receipt-hash <hash> (--stdout | --output <path>) [--title <text>] [--engine-root <dir> --package-root <dir> --archive-root <dir> --economics-root <dir>]\n');
}

export function parseArgs(argv) {
  const args = {
    receiptHash: '',
    stdout: false,
    output: '',
    title: '',
    engineRoot: '',
    packageRoot: '',
    archiveRoot: '',
    economicsRoot: '',
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
    } else if (arg === '--engine-root') {
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.receiptHash) throw new Error('--receipt-hash is required');
  if (!args.stdout && !args.output) throw new Error('Choose --stdout or --output <path>');
  if (args.stdout && args.output) throw new Error('Choose either --stdout or --output <path>, not both');
  if (args.packageRoot && (!args.engineRoot || !args.archiveRoot || !args.economicsRoot)) {
    throw new Error('--package-root requires explicit --engine-root, --archive-root, and --economics-root');
  }
  return args;
}

export function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  try {
    const args = parseArgs(argv);
    const engineRoot = args.engineRoot
      ? resolve(args.engineRoot)
      : env.TRADE_ARTIFACT_INVENTORY_ROOT
      ? resolve(env.TRADE_ARTIFACT_INVENTORY_ROOT)
      : DEFAULT_ENGINE_ROOT;

    const receipt = args.packageRoot
      ? resolveReceiptProofSourceV1({
          receiptHash: args.receiptHash,
          packageRoot: resolve(args.packageRoot),
          archiveRoot: resolve(args.archiveRoot),
          economicsRoot: resolve(args.economicsRoot),
        })
      : getInventoryReceipt(args.receiptHash, {
          engineRoot,
          includeExcluded: false,
        });

    const finish = resolvedReceipt => {
      if (!resolvedReceipt) {
        stderr.write(`No proof detail found for receipt_hash: ${args.receiptHash}\n`);
        return 1;
      }

      const proofDetail = buildProofDetailView(resolvedReceipt);
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
    };
    return typeof receipt?.then === 'function'
      ? receipt.then(finish, error => {
          printUsage(stderr);
          stderr.write(`${error.message}\n`);
          return 1;
        })
      : finish(receipt);
  } catch (error) {
    printUsage(stderr);
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runCli(process.argv.slice(2)));
}
