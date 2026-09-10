// Resolution inspection only: does not import candidate or dependency code.
import { createRequire, isBuiltin } from 'node:module';
import { readFileSync, readdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export function resolveRuntimeV1(rootInput) {
const root = resolve(rootInput);
const ts = createRequire(join(root, 'package.json'))('typescript');
const pending = [], packages = new Map(), edges = [], absent = [];
function packageRoot(entry, name) {
  let p = dirname(entry);
  for (;;) {
    if (existsSync(join(p, 'package.json'))) {
      const meta = JSON.parse(readFileSync(join(p, 'package.json')));
      if (meta.name === name) return p;
    }
    const parent = dirname(p); if (parent === p) throw Error('UNRESOLVED_PACKAGE_ROOT'); p = parent;
  }
}
function enqueue(from, name, optional = false) {
  if (isBuiltin(name)) return;
  try {
    const require = createRequire(from), baseName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
    let entry;
    try { entry = require.resolve(name); }
    catch (error) {
      if (!['ERR_PACKAGE_PATH_NOT_EXPORTED', 'MODULE_NOT_FOUND'].includes(error.code) || name !== baseName) throw error;
      // Dependencies such as @babel/runtime intentionally have no main export.
      // Locate their installed package via Node's exact lookup paths and hash
      // ALL package files, including every import/require export alternative.
      entry = require.resolve.paths(name).map(p => join(p, name, 'package.json')).find(p => existsSync(p));
      if (!entry) throw error;
    }
    const path = realpathSync(packageRoot(entry, baseName));
    edges.push({ from, specifier: name, entry: realpathSync(entry), package_root: path });
    if (!packages.has(path)) { packages.set(path, true); pending.push(path); }
  } catch (e) { if (!optional) throw e; absent.push({ from, specifier: name, disposition: 'OPTIONAL_UNRESOLVED_NO_INSTALL' }); }
}
const source = readFileSync(join(root, 'engine/docs/v1.3-supervised-repaired-integrated-source-manifest.sha256'), 'utf8').trim().split('\n').map(s => s.slice(66));
function candidateFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== '__pycache__') candidateFiles(path);
    else if (entry.isFile() && /\.(mjs|js)$/.test(path)) source.push(path.slice(root.length + 1));
  }
}
candidateFiles(join(root, 'engine/deployment/private-binding'));
for (const path of source.filter(p => /\.(mjs|js)$/.test(p))) {
  const full = join(root, path), text = readFileSync(full, 'utf8');
  function walk(node) {
    let literal;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) literal = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) literal = node.arguments[0];
    if (literal && ts.isStringLiteral(literal)) {
      const spec = literal.text;
      if (!spec.startsWith('.') && !spec.startsWith('/') && !isBuiltin(spec)) enqueue(full, spec);
    }
    ts.forEachChild(node, walk);
  }
  walk(ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
}
enqueue(join(root, 'package.json'), 'typescript');
while (pending.length) {
  const path = pending.shift(), from = join(path, 'package.json'), meta = JSON.parse(readFileSync(from));
  for (const name of Object.keys(meta.dependencies ?? {}).sort()) enqueue(from, name, Object.hasOwn(meta.optionalDependencies ?? {}, name));
  for (const name of Object.keys(meta.optionalDependencies ?? {}).sort()) if (!Object.hasOwn(meta.dependencies ?? {}, name)) enqueue(from, name, true);
  for (const name of Object.keys(meta.peerDependencies ?? {}).sort()) enqueue(from, name, meta.peerDependenciesMeta?.[name]?.optional === true);
}
return { node: realpathSync(process.execPath), node_version: process.version, node_build: process.versions,
  packages: [...packages.keys()].sort(), edges: edges.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), absent };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(resolveRuntimeV1(process.argv[2])));
