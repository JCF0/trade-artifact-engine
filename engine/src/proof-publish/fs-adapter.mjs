import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

import { DEFAULT_ENGINE_ROOT } from '../inventory/scanner.mjs';

const PUBLISH_DIR_SEGMENT = 'published';
const DRAFT_DIR_SEGMENT = 'drafts';
const BUNDLE_SUBDIR = 'p';
const MANAGED_FILES = ['index.html', 'proof.json', 'manifest.json'];

function normalizeVisibility(value) {
  if (value === 'private') return 'private';
  if (value === 'public') return 'public';
  return 'unlisted';
}

function defaultRootForVisibility(engineRoot, visibility) {
  return resolve(engineRoot, 'data', visibility === 'private' ? DRAFT_DIR_SEGMENT : PUBLISH_DIR_SEGMENT);
}

function bundleFilePaths(targetDir) {
  return {
    'index.html': resolve(targetDir, 'index.html'),
    'proof.json': resolve(targetDir, 'proof.json'),
    'manifest.json': resolve(targetDir, 'manifest.json'),
  };
}

export function resolvePublishTarget(options = {}) {
  const engineRoot = options.engineRoot ? resolve(options.engineRoot) : DEFAULT_ENGINE_ROOT;
  const visibility = normalizeVisibility(options.visibility);
  const slug = options.slug;

  if (typeof slug !== 'string' || slug.length === 0) {
    throw new TypeError('slug is required');
  }

  const rootDir = options.outRoot
    ? resolve(options.outRoot)
    : defaultRootForVisibility(engineRoot, visibility);
  const targetDir = resolve(rootDir, BUNDLE_SUBDIR, slug);

  return {
    engineRoot,
    visibility,
    rootDir,
    targetDir,
    filePaths: bundleFilePaths(targetDir),
  };
}

export function planBundleWrite(bundle, options = {}) {
  if (!bundle || typeof bundle !== 'object') {
    throw new TypeError('bundle is required');
  }

  const target = resolvePublishTarget({
    slug: bundle.slug,
    visibility: options.visibility || bundle.manifest?.visibility,
    outRoot: options.outRoot,
    engineRoot: options.engineRoot,
  });
  const targetExists = existsSync(target.targetDir);
  const force = options.force === true;

  return {
    ...target,
    targetExists,
    writeRequiresForce: targetExists && !force,
    managedFiles: [...MANAGED_FILES],
  };
}

export function writeBundleToDisk(bundle, options = {}) {
  if (!bundle || typeof bundle !== 'object') {
    throw new TypeError('bundle is required');
  }

  const plan = planBundleWrite(bundle, options);
  if (plan.targetExists && options.force !== true) {
    throw new Error(`Publish target already exists: ${plan.targetDir}. Re-run with --force to overwrite managed files.`);
  }

  mkdirSync(plan.targetDir, { recursive: true });
  for (const filename of plan.managedFiles) {
    writeFileSync(plan.filePaths[filename], bundle.files[filename], 'utf8');
  }

  return plan;
}
