const SECRET_PATTERNS = [
  { code: 'env_secret_reference', pattern: /\.env\b|HELIUS_API_KEY|PRIVATE_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE/i },
  { code: 'pem_private_key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'seed_phrase_text', pattern: /\b(seed phrase|mnemonic phrase|recovery phrase)\b/i },
  { code: 'solana_keypair_shape', pattern: /\[[\s\d,]{180,}\]/ },
];

const PATH_PATTERNS = [
  { code: 'windows_absolute_path', pattern: /[A-Za-z]:[\\/]/ },
  { code: 'posix_user_path', pattern: /\/Users\/|\/home\// },
  { code: 'windows_user_path', pattern: /\\Users\\/ },
  { code: 'checkout_root_path', pattern: /\.openclaw|workspace_Rusty|trade-artifact[\\/](engine|ui|programs|target|node_modules)/i },
  { code: 'node_modules_path', pattern: /node_modules/i },
  { code: 'debug_cache_raw_path', pattern: /\b(data\/debug|data\\debug|data\/cache|data\\cache|tmp_validation|raw[_-]?transaction|raw_transactions|helius_transactions|tokenTransfers|nativeTransfers)\b/i },
];

const RUNTIME_PATTERNS = [
  { code: 'api_route', pattern: /\/api\// },
  { code: 'localhost_reference', pattern: /localhost|127\.0\.0\.1/i },
  { code: 'runtime_route', pattern: /\/positions\b|\/rebuild\b|\/health\b|\/coverage\b|\/token\// },
  { code: 'runtime_action', pattern: /\b(Helius|wallet connection|connect wallet|signing request|mint now|upload now|Irys upload)\b/i },
];

const FORBIDDEN_CLAIM_PATTERNS = [
  { code: 'portfolio_claim', pattern: /\bportfolio (performance|return|pnl|coverage|summary|verified)\b/i },
  { code: 'full_history_claim', pattern: /\b(full[- ]history verified|complete trading history|entire wallet history)\b/i },
  { code: 'trader_skill_claim', pattern: /\btrader[- ]skill|trader skill|best trader|skill ranking\b/i },
  { code: 'track_record_claim', pattern: /\b(verified track[- ]record|proven track[- ]record|track record score)\b/i },
  { code: 'anti_wash_claim', pattern: /\b(anti[- ]wash verified|wash trading cleared|wash trading safe)\b/i },
  { code: 'prize_claim', pattern: /\b(prize eligible|eligible for prize|prize eligibility verified)\b/i },
  { code: 'usd_pnl_claim', pattern: /\bUSD[- ]?PnL|usd_pnl|realized_pnl_usd|normalized_realized_pnl_usd\b/i },
  { code: 'leaderboard_claim', pattern: /\b(leaderboard rank|ranked trader leaderboard|wallet leaderboard score)\b/i },
];

const COVERAGE_REQUIRED = [
  'Coverage Statement',
  'Receipt-scoped coverage only',
  'Raw quote only. No USD normalization.',
];


function isTextBundleFile(filename) {
  return filename === '_headers'
    || filename.endsWith('.html')
    || filename.endsWith('.json')
    || filename.endsWith('.txt')
    || filename.endsWith('.css')
    || filename.endsWith('.svg');
}

function textContent(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}
function isLikelyFullWallet(value) {
  if (typeof value !== 'string') return false;
  if (value.includes('...') || value === '[redacted]') return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function walk(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, [...path, String(index)]));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walk(child, visitor, [...path, key]);
  }
}

function addPatternFindings(findings, filename, content, patterns) {
  for (const { code, pattern } of patterns) {
    if (pattern.test(content)) findings.push({ code, filename });
  }
}

function inspectJson(findings, filename, content) {
  if (!filename.endsWith('.json')) return;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    findings.push({ code: 'invalid_json', filename });
    return;
  }

  walk(parsed, (value, path) => {
    const key = path[path.length - 1] || '';
    if (key === 'diagnostics' || key === 'engine_root' || key === 'canonical_receipt_record' || key === 'inventory_record') {
      findings.push({ code: 'diagnostic_or_archive_record_exposed', filename, path: path.join('.') });
    }
    if (key === 'wallet' && isLikelyFullWallet(value)) {
      findings.push({ code: 'full_wallet_exposed', filename, path: path.join('.') });
    }
    if (typeof value === 'string' && isLikelyFullWallet(value) && /wallet|pubkey|authority/i.test(key)) {
      findings.push({ code: 'full_wallet_exposed', filename, path: path.join('.') });
    }
  });
}

function requiresCoverageStatement(filename) {
  return filename === 'index.html' || /^receipts\/[^/]+\/index\.html$/.test(filename);
}

function inspectCoverage(findings, filename, content) {
  if (!requiresCoverageStatement(filename)) return;
  for (const required of COVERAGE_REQUIRED) {
    if (!content.includes(required)) {
      findings.push({ code: 'missing_coverage_statement', filename, required });
    }
  }
}

export function runPublicDemoLeakCheck(files, options = {}) {
  if (!files || typeof files !== 'object') {
    throw new TypeError('files is required');
  }

  const findings = [];
  const expectedReceiptHashes = new Set(options.expectedReceiptHashes || []);

  const searchableText = [];
  for (const filename of Object.keys(files).sort()) {
    addPatternFindings(findings, filename, filename, [...SECRET_PATTERNS, ...PATH_PATTERNS, ...RUNTIME_PATTERNS]);
    if (!isTextBundleFile(filename)) continue;
    const content = textContent(files[filename]);
    searchableText.push(content);
    addPatternFindings(findings, filename, content, SECRET_PATTERNS);
    addPatternFindings(findings, filename, content, PATH_PATTERNS);
    addPatternFindings(findings, filename, content, RUNTIME_PATTERNS);
    addPatternFindings(findings, filename, content, FORBIDDEN_CLAIM_PATTERNS);
    inspectJson(findings, filename, content);
    inspectCoverage(findings, filename, content);
  }

  const serialized = searchableText.join('\n');
  for (const hash of expectedReceiptHashes) {
    if (!serialized.includes(hash)) findings.push({ code: 'selected_receipt_missing', receipt_hash: hash });
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}

export function assertPublicDemoLeakCheck(files, options = {}) {
  const result = runPublicDemoLeakCheck(files, options);
  if (!result.ok) {
    const error = new Error(`public demo leak check failed: ${result.findings.map(finding => finding.code).join(', ')}`);
    error.findings = result.findings;
    throw error;
  }
  return result;
}
