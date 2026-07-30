#!/usr/bin/env node
import { resolve } from 'path';
import { pathToFileURL } from 'url';

import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';
import { getInventoryReceipt } from '../inventory/inventory.mjs';
import { buildProofDetailView } from '../proof-detail/view-model.mjs';
import { resolveReceiptProofSourceV1 } from '../proof-source/package-native-proof-source.mjs';
import { buildPublishBundle } from './publish-bundle.mjs';
import { planBundleWrite, writeBundleToDisk } from './fs-adapter.mjs';

const VALID_VISIBILITY = new Set(['unlisted', 'public', 'private']);
const VALID_WALLET_DISPLAY = new Set(['truncated', 'redacted', 'full']);



export function printUsage(stderr = process.stderr) {
  stderr.write('Usage: node engine/src/proof-publish/cli.mjs --receipt-hash <hash> [--engine-root <root>] [--package-root <root> --archive-root <root> --economics-root <root>] [--dry-run | --write] [--force] [--visibility unlisted|public|private] [--wallet-display truncated|redacted|full] [--out <root>] [--base-url <http(s)://...>]\n');
}

export function parseArgs(argv) {
  const args = {
    receiptHash: '',
    dryRun: false,
    write: false,
    force: false,
    visibility: 'unlisted',
    walletDisplay: 'truncated',
    outRoot: '',
    baseUrl: '',
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
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--write') {
      args.write = true;
    } else if (arg === '--force') {
      args.force = true;
    } else if (arg === '--visibility') {
      args.visibility = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--wallet-display') {
      args.walletDisplay = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--out') {
      args.outRoot = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--base-url') {
      args.baseUrl = argv[i + 1] || '';
      i += 1;
    } else if (arg === '--engine-root') {
      args.engineRoot = argv[++i] || '';
    } else if (arg === '--package-root') {
      args.packageRoot = argv[++i] || '';
    } else if (arg === '--archive-root') {
      args.archiveRoot = argv[++i] || '';
    } else if (arg === '--economics-root') {
      args.economicsRoot = argv[++i] || '';
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.receiptHash) throw new Error('--receipt-hash is required');
  if (args.dryRun && args.write) throw new Error('--dry-run and --write are mutually exclusive');
  if (!VALID_VISIBILITY.has(args.visibility)) throw new Error(`Unsupported visibility: ${args.visibility}`);
  if (!VALID_WALLET_DISPLAY.has(args.walletDisplay)) throw new Error(`Unsupported wallet display mode: ${args.walletDisplay}`);
  if (args.baseUrl && !/^https?:\/\//.test(args.baseUrl)) throw new Error('--base-url must start with http:// or https://');
  if (args.packageRoot && (!args.engineRoot || !args.archiveRoot || !args.economicsRoot)) {
    throw new Error('--package-root requires explicit --engine-root, --archive-root, and --economics-root');
  }

  return args;
}

function renderDryRun(plan, bundle) {
  return [
    'Publish dry run',
    `receipt_hash: ${bundle.manifest.receipt_hash}`,
    `slug: ${bundle.slug}`,
    `visibility: ${bundle.manifest.visibility}`,
    `wallet_display_mode: ${bundle.manifest.wallet_display_mode}`,
    `target_dir: ${plan.targetDir}`,
    `hosted_url: ${bundle.manifest.hosted_url}`,
    'files:',
    ...plan.managedFiles.map(name => `- ${name}`),
    `target_exists: ${plan.targetExists ? 'yes' : 'no'}`,
    `write_requires_force: ${plan.writeRequiresForce ? 'yes' : 'no'}`,
    '',
  ].join('\n');
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
      : getInventoryReceipt(args.receiptHash, { engineRoot, includeExcluded: false });

    const finish = resolvedReceipt => {
      if (!resolvedReceipt) {
        stderr.write(`No proof detail found for receipt_hash: ${args.receiptHash}\n`);
        return 1;
      }
      const proofDetail = buildProofDetailView(resolvedReceipt);
      const bundle = buildPublishBundle(proofDetail, {
        visibility: args.visibility,
        wallet_display_mode: args.walletDisplay,
        base_url: args.baseUrl || null,
      });
      const plan = planBundleWrite(bundle, {
        visibility: args.visibility,
        outRoot: args.outRoot || undefined,
        engineRoot,
        force: args.force,
      });
      if (!args.write) {
        stdout.write(renderDryRun(plan, bundle));
        return 0;
      }
      const written = writeBundleToDisk(bundle, {
        visibility: args.visibility,
        outRoot: args.outRoot || undefined,
        engineRoot,
        force: args.force,
      });
      stderr.write(`Wrote publish bundle to ${written.targetDir}\n`);
      return 0;
    };
    return typeof receipt?.then === 'function'
      ? receipt.then(finish).catch(error => {
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
