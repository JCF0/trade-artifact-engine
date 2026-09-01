import { PublicKey } from '@solana/web3.js';
import { types as utilTypes } from 'node:util';

import { cloneAndFreeze } from '../verification-scope-v1-3/contract.mjs';
import { isSolanaPublicKeyV1 } from './solana-identities.mjs';

export const CLASSIC_TOKEN_PROGRAM_V1 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_V1 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const LOCALLY_DECODED_TOKEN_ACCOUNT_PROFILE_V1 = 'LOCALLY_DECODED_SOLANA_TOKEN_ACCOUNT_STATE_V1';

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ACCOUNT_SIZE = 165;
const MULTISIG_SIZE = 355;
const MINT_SIZE = 82;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;
const ACCOUNT_EXTENSIONS = new Map([
  [2, { name: 'TRANSFER_FEE_AMOUNT', length: 8, supported: false }],
  [5, { name: 'CONFIDENTIAL_TRANSFER_ACCOUNT', length: 295, supported: false }],
  [7, { name: 'IMMUTABLE_OWNER', length: 0, supported: true }],
  [8, { name: 'MEMO_TRANSFER', length: 1, supported: true }],
  [11, { name: 'CPI_GUARD', length: 1, supported: false }],
  [13, { name: 'NON_TRANSFERABLE_ACCOUNT', length: 0, supported: false }],
  [15, { name: 'TRANSFER_HOOK_ACCOUNT', length: 1, supported: false }],
  [27, { name: 'PAUSABLE_ACCOUNT', length: 0, supported: false }],
]);

export class SolanaTokenAccountDecodeError extends Error {
  constructor(code) {
    super('Solana token account evidence is invalid');
    this.name = 'SolanaTokenAccountDecodeError';
    this.code = code;
    delete this.stack;
  }
}
function fail(code) { throw new SolanaTokenAccountDecodeError(code); }
function u32(bytes, offset) { return bytes.readUInt32LE(offset); }
function u64(bytes, offset) { return bytes.readBigUInt64LE(offset); }
function key(bytes, offset) {
  try { return new PublicKey(bytes.subarray(offset, offset + 32)).toBase58(); } catch { fail('token_account_public_key_invalid'); }
}
function canonicalBytes(value) {
  if (typeof value !== 'string' || value.length === 0 || !BASE64.test(value)) fail('token_account_base64_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('token_account_base64_invalid');
  return bytes;
}
function coptionKey(bytes, tagOffset, keyOffset, code) {
  const tag = u32(bytes, tagOffset);
  if (tag !== 0 && tag !== 1) fail(code);
  return tag === 1 ? key(bytes, keyOffset) : null;
}
function parseTlv(bytes, offset, definitions) {
  const seen = new Set();
  const names = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 4) fail('token_2022_tlv_malformed');
    const type = bytes.readUInt16LE(offset);
    const length = bytes.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > bytes.length || type === 0 || seen.has(type)) fail('token_2022_tlv_malformed');
    const definition = definitions.get(type);
    if (definition === undefined) fail('token_2022_extension_unsupported');
    if (definition.length !== length) fail('token_2022_tlv_malformed');
    if (!definition.supported) fail('token_2022_extension_unsupported');
    const value = bytes.subarray(offset, offset + length);
    if ((type === 8 || type === 15) && value[0] !== 0 && value[0] !== 1) fail('token_2022_tlv_malformed');
    seen.add(type);
    names.push(definition.name);
    offset += length;
  }
  return names;
}
function validateInput(input, fields) {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
        || Object.getPrototypeOf(input) !== Object.prototype || Object.getOwnPropertySymbols(input).length !== 0
        || Object.keys(input).sort().join('\0') !== [...fields].sort().join('\0')) {
      fail('token_account_decode_input_invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.values(descriptors).some(descriptor => !descriptor.enumerable
        || !Object.hasOwn(descriptor, 'value'))) {
      fail('token_account_decode_input_invalid');
    }
  } catch (error) {
    if (error instanceof SolanaTokenAccountDecodeError) throw error;
    fail('token_account_decode_input_invalid');
  }
}

export function decodeSolanaTokenAccountDataV1(input) {
  validateInput(input, ['raw_base64', 'token_program', 'expected_wallet']);
  if (!isSolanaPublicKeyV1(input.expected_wallet)
      || (input.token_program !== CLASSIC_TOKEN_PROGRAM_V1 && input.token_program !== TOKEN_2022_PROGRAM_V1)) {
    fail('token_account_decode_input_invalid');
  }
  const bytes = canonicalBytes(input.raw_base64);
  let extensions = [];
  if (input.token_program === CLASSIC_TOKEN_PROGRAM_V1) {
    if (bytes.length !== ACCOUNT_SIZE) fail('classic_token_account_size_invalid');
  } else if (bytes.length !== ACCOUNT_SIZE) {
    if (bytes.length <= ACCOUNT_SIZE || bytes.length === MULTISIG_SIZE || bytes[ACCOUNT_SIZE] !== ACCOUNT_TYPE_ACCOUNT) {
      fail('token_2022_account_size_invalid');
    }
    extensions = parseTlv(bytes, ACCOUNT_SIZE + 1, ACCOUNT_EXTENSIONS);
  }
  const mint = key(bytes, 0);
  const tokenAuthority = key(bytes, 32);
  if (tokenAuthority !== input.expected_wallet) fail('token_account_authority_mismatch');
  const delegate = coptionKey(bytes, 72, 76, 'token_account_delegate_invalid');
  const delegated = u64(bytes, 121);
  if (delegate === null && delegated !== 0n) fail('token_account_delegate_invalid');
  const state = bytes[108];
  if (state !== 1 && state !== 2) fail('token_account_state_invalid');
  const nativeTag = u32(bytes, 109);
  if (nativeTag !== 0 && nativeTag !== 1) fail('token_account_native_state_invalid');
  if (nativeTag === 1) fail('token_account_native_state_unsupported');
  const closeAuthority = coptionKey(bytes, 129, 133, 'token_account_close_authority_invalid');
  return cloneAndFreeze({
    normalized_state_profile: LOCALLY_DECODED_TOKEN_ACCOUNT_PROFILE_V1,
    token_state: {
      mint,
      token_authority: tokenAuthority,
      raw_amount: u64(bytes, 64).toString(),
      decimals: null,
      delegate_status: delegate === null ? 'NONE' : 'PRESENT',
      delegate,
      delegated_raw_amount: delegated.toString(),
      close_authority_status: closeAuthority === null ? 'NONE' : 'PRESENT',
      close_authority: closeAuthority,
      lifecycle_state: 'EXISTS',
      account_state: state === 1 ? 'INITIALIZED' : 'FROZEN',
    },
    token_2022_extensions: extensions,
  });
}

export function decodeToken2022MintDataV1(input) {
  validateInput(input, ['raw_base64', 'expected_mint']);
  if (!isSolanaPublicKeyV1(input.expected_mint)) fail('token_account_decode_input_invalid');
  const bytes = canonicalBytes(input.raw_base64);
  if (bytes.length !== MINT_SIZE) {
    if (bytes.length <= ACCOUNT_SIZE || bytes.length === MULTISIG_SIZE || bytes[ACCOUNT_SIZE] !== ACCOUNT_TYPE_MINT) {
      fail('token_2022_mint_size_invalid');
    }
    // Positive Token-2022 authority remains disabled. No mint extension is admitted yet.
    fail('token_2022_mint_extension_unsupported');
  }
  for (const [offset, code] of [[0, 'token_2022_mint_authority_invalid'], [46, 'token_2022_freeze_authority_invalid']]) {
    const tag = u32(bytes, offset);
    if (tag !== 0 && tag !== 1) fail(code);
  }
  if (bytes[45] !== 1) fail('token_2022_mint_uninitialized');
  return cloneAndFreeze({
    mint: input.expected_mint,
    decimals: bytes[44],
    supply: u64(bytes, 36).toString(),
    mint_extensions: [],
  });
}
