import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export const TOKEN_DISPLAY_REGISTRY_VERSION = 'token_display_metadata_v1';
export const TOKEN_DISPLAY_REGISTRY_SOURCE = Object.freeze({
  type: 'curated_snapshot',
  provider: 'project_review',
});
export const TOKEN_DISPLAY_REGISTRY_URL = new URL(
  '../../assets/data/token-display-metadata-v1.json',
  import.meta.url,
);

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,9}$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'-]{0,63}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DOCUMENT_KEYS = ['records', 'registry_version', 'source'];
const RECORD_KEYS = ['metadata_record_hash', 'mint', 'name', 'source', 'symbol'];
const SOURCE_KEYS = ['provider', 'type'];

export class TokenDisplayRegistryError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TokenDisplayRegistryError';
    this.code = code;
    this.details = details;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortStable(value) {
  if (Array.isArray(value)) return value.map(sortStable);
  if (!isPlainObject(value)) return value;

  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortStable(value[key]);
  return sorted;
}

function stableJson(value) {
  return `${JSON.stringify(sortStable(value), null, 2)}\n`;
}

function stableClone(value) {
  return JSON.parse(stableJson(value));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertExactKeys(value, expectedKeys, context) {
  if (!isPlainObject(value)) {
    throw new TokenDisplayRegistryError('invalid_schema', `${context} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actualKeys.length !== expected.length || actualKeys.some((key, index) => key !== expected[index])) {
    throw new TokenDisplayRegistryError('invalid_schema', `${context} has unexpected or missing fields`, {
      actual_keys: actualKeys,
      expected_keys: expected,
    });
  }
}

function assertStaticSource(source, context) {
  assertExactKeys(source, SOURCE_KEYS, context);
  if (source.type !== TOKEN_DISPLAY_REGISTRY_SOURCE.type
    || source.provider !== TOKEN_DISPLAY_REGISTRY_SOURCE.provider) {
    throw new TokenDisplayRegistryError('invalid_source', `${context} must identify the reviewed curated snapshot`, {
      source,
    });
  }
}

function assertMint(mint, context = 'mint') {
  if (typeof mint !== 'string' || !MINT_PATTERN.test(mint)) {
    throw new TokenDisplayRegistryError('invalid_mint', `${context} must be a full Solana base58 mint`, {
      mint,
    });
  }
}

function calculateRecordHash(record) {
  const payload = {
    mint: record.mint,
    name: record.name,
    source: record.source,
    symbol: record.symbol,
  };
  return createHash('sha256').update(stableJson(payload), 'utf8').digest('hex');
}

function validateRecord(record, index) {
  const context = `records[${index}]`;
  assertExactKeys(record, RECORD_KEYS, context);
  assertMint(record.mint, `${context}.mint`);

  if (typeof record.symbol !== 'string' || !SYMBOL_PATTERN.test(record.symbol)) {
    throw new TokenDisplayRegistryError(
      'invalid_symbol',
      `${context}.symbol must be 1-10 uppercase ASCII letters, digits, dot, underscore, or hyphen`,
      { mint: record.mint, symbol: record.symbol },
    );
  }
  if (typeof record.name !== 'string'
    || !NAME_PATTERN.test(record.name)
    || record.name.trim() !== record.name
    || / {2}/.test(record.name)) {
    throw new TokenDisplayRegistryError(
      'invalid_name',
      `${context}.name must be 1-64 conservative ASCII display characters with no edge or repeated spaces`,
      { mint: record.mint, name: record.name },
    );
  }

  assertStaticSource(record.source, `${context}.source`);
  if (typeof record.metadata_record_hash !== 'string'
    || !HASH_PATTERN.test(record.metadata_record_hash)) {
    throw new TokenDisplayRegistryError(
      'invalid_record_hash',
      `${context}.metadata_record_hash must be a lowercase SHA-256 hex digest`,
      { mint: record.mint, metadata_record_hash: record.metadata_record_hash },
    );
  }

  const expectedHash = calculateRecordHash(record);
  if (record.metadata_record_hash !== expectedHash) {
    throw new TokenDisplayRegistryError(
      'record_hash_mismatch',
      `${context}.metadata_record_hash does not match its canonical display metadata`,
      {
        mint: record.mint,
        expected_hash: expectedHash,
        actual_hash: record.metadata_record_hash,
      },
    );
  }

  return stableClone(record);
}

function shortenMint(mint) {
  return mint.length <= 8 ? mint : `${mint.slice(0, 8)}...`;
}

function resolveFromMap(recordsByMint, mint) {
  assertMint(mint);
  const record = recordsByMint.get(mint);
  if (!record) {
    return {
      mint,
      display: shortenMint(mint),
      display_kind: 'mint_prefix',
    };
  }

  return {
    mint,
    display: record.symbol,
    display_kind: 'symbol',
    symbol: record.symbol,
    name: record.name,
    source: {
      type: record.source.type,
      provider: record.source.provider,
    },
  };
}

export function buildTokenDisplayRegistry(document) {
  assertExactKeys(document, DOCUMENT_KEYS, 'registry');
  if (document.registry_version !== TOKEN_DISPLAY_REGISTRY_VERSION) {
    throw new TokenDisplayRegistryError('unsupported_version', 'registry.registry_version is not supported', {
      registry_version: document.registry_version,
    });
  }
  assertStaticSource(document.source, 'registry.source');
  if (!Array.isArray(document.records)) {
    throw new TokenDisplayRegistryError('invalid_schema', 'registry.records must be an array');
  }

  const records = [];
  const recordsByMint = new Map();
  for (let index = 0; index < document.records.length; index += 1) {
    const record = validateRecord(document.records[index], index);
    if (recordsByMint.has(record.mint)) {
      throw new TokenDisplayRegistryError('duplicate_mint', 'registry contains a duplicate or conflicting full mint', {
        mint: record.mint,
      });
    }
    records.push(deepFreeze(record));
    recordsByMint.set(record.mint, record);
  }

  const sortedMints = records.map(record => record.mint).sort();
  if (records.some((record, index) => record.mint !== sortedMints[index])) {
    throw new TokenDisplayRegistryError('unsorted_records', 'registry records must be sorted by full mint');
  }

  const frozenRecords = Object.freeze(records);
  return Object.freeze({
    registry_version: TOKEN_DISPLAY_REGISTRY_VERSION,
    source: TOKEN_DISPLAY_REGISTRY_SOURCE,
    records: frozenRecords,
    resolve(mint) {
      return resolveFromMap(recordsByMint, mint);
    },
  });
}

export function parseTokenDisplayRegistry(text) {
  if (typeof text !== 'string') {
    throw new TokenDisplayRegistryError('invalid_json', 'registry text must be a string');
  }

  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new TokenDisplayRegistryError('invalid_json', 'registry text must contain valid JSON', {
      cause: error.message,
    });
  }
  return buildTokenDisplayRegistry(document);
}

const STATIC_TOKEN_DISPLAY_REGISTRY = parseTokenDisplayRegistry(
  readFileSync(TOKEN_DISPLAY_REGISTRY_URL, 'utf8'),
);

export function resolveTokenDisplayMetadata(mint) {
  return STATIC_TOKEN_DISPLAY_REGISTRY.resolve(mint);
}
