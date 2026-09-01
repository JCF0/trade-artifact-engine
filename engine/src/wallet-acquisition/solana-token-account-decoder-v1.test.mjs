import assert from 'node:assert/strict';
import test from 'node:test';

import { PublicKey } from '@solana/web3.js';

import {
  decodeSolanaTokenAccountDataV1,
  decodeToken2022MintDataV1,
} from './solana-token-account-decoder-v1.mjs';

const CLASSIC = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MINT = 'So11111111111111111111111111111111111111112';
const WALLET = '4EYja5iaLCgX2yKi8dVghnD12A2EMBwWaqQfuySBLUF1';
const DELEGATE = 'GtXWTjMWWaDtxd2u6rChSzfCfgdzPFmTjVNfbLjp6h2e';

function keyBytes(value) { return new PublicKey(value).toBuffer(); }
function u64(value) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return out; }
function u32(value) { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; }
function accountBytes({ amount = 9n, delegate = null, delegated = 0n, close = null, state = 1, extensions = [] } = {}) {
  const out = Buffer.alloc(165);
  keyBytes(MINT).copy(out, 0);
  keyBytes(WALLET).copy(out, 32);
  u64(amount).copy(out, 64);
  u32(delegate === null ? 0 : 1).copy(out, 72);
  if (delegate !== null) keyBytes(delegate).copy(out, 76);
  out[108] = state;
  u32(0).copy(out, 109);
  u64(delegated).copy(out, 121);
  u32(close === null ? 0 : 1).copy(out, 129);
  if (close !== null) keyBytes(close).copy(out, 133);
  if (extensions.length === 0) return out;
  const tlv = extensions.map(({ type, bytes }) => Buffer.concat([u32(type).subarray(0, 2), u32(bytes.length).subarray(0, 2), bytes]));
  return Buffer.concat([out, Buffer.from([2]), ...tlv]);
}
function mintBytes({ decimals = 9, extensions = [] } = {}) {
  const out = Buffer.alloc(82);
  u32(0).copy(out, 0);
  u64(1_000_000n).copy(out, 36);
  out[44] = decimals;
  out[45] = 1;
  u32(0).copy(out, 46);
  if (extensions.length === 0) return out;
  const padding = Buffer.alloc(165 - out.length);
  const tlv = extensions.map(({ type, bytes }) => Buffer.concat([u32(type).subarray(0, 2), u32(bytes.length).subarray(0, 2), bytes]));
  return Buffer.concat([out, padding, Buffer.from([1]), ...tlv]);
}
function fails(code, operation) {
  assert.throws(operation, error => error?.code === code);
}

test('classic decoder derives raw state and leaves decimals null', () => {
  const decoded = decodeSolanaTokenAccountDataV1({
    raw_base64: accountBytes({ amount: 42n, delegate: DELEGATE, delegated: 7n, close: DELEGATE }).toString('base64'),
    token_program: CLASSIC,
    expected_wallet: WALLET,
  });
  assert.deepEqual(decoded, {
    normalized_state_profile: 'LOCALLY_DECODED_SOLANA_TOKEN_ACCOUNT_STATE_V1',
    token_state: {
      mint: MINT,
      token_authority: WALLET,
      raw_amount: '42',
      decimals: null,
      delegate_status: 'PRESENT',
      delegate: DELEGATE,
      delegated_raw_amount: '7',
      close_authority_status: 'PRESENT',
      close_authority: DELEGATE,
      lifecycle_state: 'EXISTS',
      account_state: 'INITIALIZED',
    },
    token_2022_extensions: [],
  });
});

test('Token-2022 decoder admits a canonical ImmutableOwner TLV', () => {
  const decoded = decodeSolanaTokenAccountDataV1({
    raw_base64: accountBytes({ extensions: [{ type: 7, bytes: Buffer.alloc(0) }] }).toString('base64'),
    token_program: TOKEN_2022,
    expected_wallet: WALLET,
  });
  assert.deepEqual(decoded.token_2022_extensions, ['IMMUTABLE_OWNER']);
  assert.equal(decoded.token_state.decimals, null);
});

test('decoder rejects unsupported Token-2022 account semantics', () => {
  fails('token_2022_extension_unsupported', () => decodeSolanaTokenAccountDataV1({
    raw_base64: accountBytes({ extensions: [{ type: 2, bytes: Buffer.alloc(8) }] }).toString('base64'),
    token_program: TOKEN_2022,
    expected_wallet: WALLET,
  }));
});

test('decoder fails closed on wrapped-native account semantics not represented by the carrier', () => {
  const bytes = accountBytes();
  u32(1).copy(bytes, 109);
  u64(2_039_280).copy(bytes, 113);
  fails('token_account_native_state_unsupported', () => decodeSolanaTokenAccountDataV1({
    raw_base64: bytes.toString('base64'), token_program: CLASSIC, expected_wallet: WALLET,
  }));
});

test('Token-2022 mint decoder establishes decimals only from strict raw mint evidence', () => {
  const decoded = decodeToken2022MintDataV1({
    raw_base64: mintBytes({ decimals: 6 }).toString('base64'),
    expected_mint: MINT,
  });
  assert.deepEqual(decoded, {
    mint: MINT,
    decimals: 6,
    supply: '1000000',
    mint_extensions: [],
  });
});

test('decoder rejects symbol-bearing and revoked-proxy inputs with its fixed local error', () => {
  const symbolInput = {
    raw_base64: accountBytes().toString('base64'), token_program: CLASSIC, expected_wallet: WALLET,
  };
  symbolInput[Symbol('hidden')] = 'unsafe';
  fails('token_account_decode_input_invalid', () => decodeSolanaTokenAccountDataV1(symbolInput));

  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  fails('token_account_decode_input_invalid', () => decodeSolanaTokenAccountDataV1(proxy));

  let getterCalls = 0;
  const accessorInput = {
    token_program: CLASSIC,
    expected_wallet: WALLET,
    get raw_base64() { getterCalls += 1; return accountBytes().toString('base64'); },
  };
  fails('token_account_decode_input_invalid', () => decodeSolanaTokenAccountDataV1(accessorInput));
  assert.equal(getterCalls, 0);
});

test('classic decoder fails closed across size, option, authority, and lifecycle contradictions', () => {
  const cases = [
    ['classic_token_account_size_invalid', accountBytes().subarray(0, 164)],
    ['token_account_delegate_invalid', (() => { const b = accountBytes(); u32(2).copy(b, 72); return b; })()],
    ['token_account_delegate_invalid', (() => { const b = accountBytes(); u64(1).copy(b, 121); return b; })()],
    ['token_account_state_invalid', accountBytes({ state: 0 })],
    ['token_account_state_invalid', accountBytes({ state: 3 })],
    ['token_account_native_state_invalid', (() => { const b = accountBytes(); u32(2).copy(b, 109); return b; })()],
    ['token_account_close_authority_invalid', (() => { const b = accountBytes(); u32(2).copy(b, 129); return b; })()],
  ];
  for (const [code, bytes] of cases) fails(code, () => decodeSolanaTokenAccountDataV1({
    raw_base64: bytes.toString('base64'), token_program: CLASSIC, expected_wallet: WALLET,
  }));
  fails('token_account_authority_mismatch', () => decodeSolanaTokenAccountDataV1({
    raw_base64: accountBytes().toString('base64'), token_program: CLASSIC, expected_wallet: DELEGATE,
  }));
});

test('Token-2022 TLV decoder rejects wrong account type, truncation, duplication, unknown types, and wrong lengths', () => {
  const base = accountBytes();
  const cases = [
    Buffer.concat([base, Buffer.from([1])]),
    Buffer.concat([base, Buffer.from([2, 7, 0])]),
    Buffer.concat([base, Buffer.from([2, 7, 0, 0, 0, 7, 0, 0, 0])]),
    Buffer.concat([base, Buffer.from([2, 99, 0, 0, 0])]),
    Buffer.concat([base, Buffer.from([2, 7, 0, 1, 0, 0])]),
  ];
  const expected = [
    'token_2022_account_size_invalid', 'token_2022_tlv_malformed', 'token_2022_tlv_malformed',
    'token_2022_extension_unsupported', 'token_2022_tlv_malformed',
  ];
  cases.forEach((bytes, index) => fails(expected[index], () => decodeSolanaTokenAccountDataV1({
    raw_base64: bytes.toString('base64'), token_program: TOKEN_2022, expected_wallet: WALLET,
  })));
});

test('Token-2022 mint decoder rejects uninitialized, malformed, and extension-bearing mint evidence', () => {
  const uninitialized = mintBytes();
  uninitialized[45] = 0;
  fails('token_2022_mint_uninitialized', () => decodeToken2022MintDataV1({
    raw_base64: uninitialized.toString('base64'), expected_mint: MINT,
  }));
  fails('token_2022_mint_size_invalid', () => decodeToken2022MintDataV1({
    raw_base64: mintBytes().subarray(0, 81).toString('base64'), expected_mint: MINT,
  }));
  fails('token_2022_mint_extension_unsupported', () => decodeToken2022MintDataV1({
    raw_base64: mintBytes({ extensions: [{ type: 12, bytes: Buffer.alloc(32) }] }).toString('base64'),
    expected_mint: MINT,
  }));
});
