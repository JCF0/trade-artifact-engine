#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '..');
const allowedBuiltins = new Set(['crypto', 'node:crypto', 'node:util']);
const forbiddenImportPath = /(?:^|[/.-])(fs|filesystem|http|https|net|tls|dgram|dns|socket|child_process|worker_threads|cluster|provider|adapter|package-store|package_store|upload|sign(?:ing|er)?|mint|deploy|api|ui|job|publish(?:er|ing|cation)?)(?:[/.-]|$)/i;
const forbiddenSourcePatterns = [
  [/\bimport\s*\(/, 'dynamic import'],
  [/\b(?:createRequire|module\s*\.\s*require)\b/, 'runtime module loading'],
  [/\bprocess\s*\.\s*env\b/, 'environment-variable access'],
  [/\b(?:process|globalThis)\s*\[/, 'computed ambient capability access'],
  [/\bprocess\s*\.\s*(?:binding|dlopen)\b/, 'native runtime capability access'],
  [/\b(?:Deno|Bun)\s*\.\s*env\b|\bimport\s*\.\s*meta\s*\.\s*env\b/, 'environment-variable access'],
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/, 'network client'],
  [/\b(?:readFile|writeFile|appendFile|mkdir|rename|unlink|rm|createReadStream|createWriteStream)Sync?\s*\(/, 'filesystem operation'],
  [/\b(?:spawn|exec|execFile|fork)Sync?\s*\(/, 'child process'],
  [/\bnew\s+(?:Worker|MessageChannel)\b/, 'worker'],
  [/\b(?:eval|Function)\s*\(/, 'dynamic code execution'],
  [/\b(?:Math\s*\.\s*random|performance\s*\.\s*now|randomBytes|randomUUID|getRandomValues)\s*\(/, 'ambient nondeterminism'],
];

function sourceModulesInCandidateSet() {
  const pending = [here];
  const modules = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures') pending.push(path);
      } else if (entry.isFile() && extname(entry.name) === '.mjs' && !entry.name.endsWith('.test.mjs')) {
        modules.push(path);
      }
    }
  }
  return modules.sort();
}

function importSpecifiers(source) {
  const specs = [];
  const staticPattern = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    let match;
    while ((match = pattern.exec(source)) !== null) specs.push(match[1]);
  }
  return specs;
}

function resolveLocalImport(parent, specifier) {
  const resolved = resolve(dirname(parent), specifier);
  if (!resolved.startsWith(`${sourceRoot}/`)) throw new Error(`local import escapes source root: ${specifier}`);
  if (!statSync(resolved).isFile()) throw new Error(`local import is not a file: ${specifier}`);
  return resolved;
}

function buildTransitiveGraph(entries) {
  const pending = [...entries];
  const modules = new Map();
  while (pending.length) {
    const path = pending.pop();
    if (modules.has(path)) continue;
    const source = readFileSync(path, 'utf8');
    const imports = importSpecifiers(source);
    modules.set(path, { source, imports });
    for (const specifier of imports) {
      if (specifier.startsWith('.')) pending.push(resolveLocalImport(path, specifier));
    }
  }
  return modules;
}

function auditGraph(graph) {
  const findings = [];
  for (const [path, module] of graph) {
    const name = relative(sourceRoot, path);
    for (const specifier of module.imports) {
      if (specifier.startsWith('.')) {
        const imported = relative(sourceRoot, resolveLocalImport(path, specifier));
        if (forbiddenImportPath.test(imported)) findings.push(`${name}: forbidden local import ${imported}`);
      } else if (!allowedBuiltins.has(specifier)) {
        findings.push(`${name}: non-allowlisted external or builtin import ${specifier}`);
      }
    }
    for (const [pattern, capability] of forbiddenSourcePatterns) {
      if (pattern.test(module.source)) findings.push(`${name}: ${capability}`);
    }
    if (/\brequire\s*\(/.test(module.source)) findings.push(`${name}: CommonJS require capability is not allowed`);
  }
  return findings.sort();
}

test('complete transitive candidate-set production graph is capability-free', () => {
  const entries = sourceModulesInCandidateSet();
  const graph = buildTransitiveGraph(entries);
  assert.equal(entries.length, 19);
  assert.deepEqual([...new Set([...graph.values()].flatMap(module => module.imports).filter(specifier => !specifier.startsWith('.')))].sort(), ['crypto', 'node:crypto', 'node:util']);
  assert.deepEqual(auditGraph(graph), []);
  assert.deepEqual(
    [...graph.keys()].map(path => relative(sourceRoot, path)).sort(),
    [
      'candidate-set/acquisition-result.mjs',
      'candidate-set/activity-findings.mjs',
      'candidate-set/blocked-summary.mjs',
      'candidate-set/builder.mjs',
      'candidate-set/coverage.mjs',
      'candidate-set/dispositions.mjs',
      'candidate-set/errors.mjs',
      'candidate-set/evidence-bundle.mjs',
      'candidate-set/identity.mjs',
      'candidate-set/mark-observations.mjs',
      'candidate-set/open-snapshot.mjs',
      'candidate-set/order.mjs',
      'candidate-set/plain-data.mjs',
      'candidate-set/project-candidate.mjs',
      'candidate-set/receipt-scoped-evidence.mjs',
      'candidate-set/schema.mjs',
      'candidate-set/selection-projection.mjs',
      'candidate-set/selection-resolver.mjs',
      'candidate-set/serialize.mjs',
      'ledger/position-ledger.mjs',
      'ledger/precision.mjs',
      'ledger/receipt-candidates.mjs',
      'pipeline/constants.mjs',
      'receipt-package/profiles.mjs',
  'wallet-acquisition/solana-identities.mjs',
    ],
  );
});

test('capability scanner rejects computed dynamic imports and ambient capability indirection', () => {
  const adversarial = new Map([
    [join(here, 'adversarial-dynamic.mjs'), { source: "const name = 'node:' + 'fs'; import(name);", imports: [] }],
    [join(here, 'adversarial-global.mjs'), { source: "globalThis['fetch']('https://invalid.example');", imports: [] }],
    [join(here, 'adversarial-env.mjs'), { source: "process['env']['API_KEY'];", imports: [] }],
    [join(here, 'adversarial-native.mjs'), { source: "process.binding('fs');", imports: [] }],
  ]);
  const findings = auditGraph(adversarial);
  assert.equal(findings.length, adversarial.size);
  assert.ok(findings.some(item => item.includes('dynamic import')));
  assert.ok(findings.filter(item => item.includes('computed ambient capability access')).length >= 2);
  assert.ok(findings.some(item => item.includes('native runtime capability access')));
});

test('importing every candidate-set production module performs no observable side effects', async () => {
  const observed = [];
  const globalKeysBefore = Reflect.ownKeys(globalThis).map(String).sort();
  const processListenersBefore = Object.fromEntries(process.eventNames().map(name => [String(name), process.listenerCount(name)]));
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  const originalQueueMicrotask = globalThis.queueMicrotask;
  const originalMathRandom = Math.random;
  console.log = (...args) => observed.push(['console.log', args]);
  console.info = (...args) => observed.push(['console.info', args]);
  console.warn = (...args) => observed.push(['console.warn', args]);
  console.error = (...args) => observed.push(['console.error', args]);
  globalThis.fetch = (...args) => { observed.push(['fetch', args]); throw new Error('network forbidden during import'); };
  globalThis.setTimeout = (...args) => { observed.push(['setTimeout', args]); throw new Error('timer forbidden during import'); };
  globalThis.setInterval = (...args) => { observed.push(['setInterval', args]); throw new Error('timer forbidden during import'); };
  globalThis.queueMicrotask = (...args) => { observed.push(['queueMicrotask', args]); throw new Error('microtask forbidden during import'); };
  Math.random = (...args) => { observed.push(['Math.random', args]); throw new Error('randomness forbidden during import'); };
  try {
    let nonce = 0;
    for (const path of sourceModulesInCandidateSet()) {
      await import(`${pathToFileURL(path).href}?capability-audit=${nonce++}`);
    }
  } finally {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
    globalThis.queueMicrotask = originalQueueMicrotask;
    Math.random = originalMathRandom;
  }
  assert.deepEqual(observed, []);
  assert.deepEqual(Reflect.ownKeys(globalThis).map(String).sort(), globalKeysBefore);
  assert.deepEqual(Object.fromEntries(process.eventNames().map(name => [String(name), process.listenerCount(name)])), processListenersBefore);
});
