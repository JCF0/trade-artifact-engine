import { assertPlainDataV1, cloneAndFreezePlainDataV1 } from './errors.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import { failWalletAcquisitionOperationV1 } from './provider-port.mjs';

function malformed() { failWalletAcquisitionOperationV1('malformed_provider_response'); }
function safePlain(value) { try { assertPlainDataV1(value, 'invalid_acquisition_request'); } catch { malformed(); } }
function object(value) { if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed(); return value; }
function rpcResult(value) {
  safePlain(value); object(value);
  const keys = Object.keys(value);
  if (!keys.includes('jsonrpc') || !keys.includes('id') || !keys.includes('result') || keys.some(key => !['jsonrpc','id','result'].includes(key))
      || value.jsonrpc !== '2.0' || value.id !== 'wallet-acquisition-v1') malformed();
  return value.result;
}
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function decodedBase58Length(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const bytes = [0];
  for (const character of value) {
    let carry = BASE58.indexOf(character);
    if (carry < 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === '1') leadingZeroes += 1;
  return bytes.length + leadingZeroes - (bytes.length === 1 && bytes[0] === 0 ? 1 : 0);
}
export function isSolanaPublicKeyV1(value) { return decodedBase58Length(value) === 32; }
export function isSolanaSignatureV1(value) { return decodedBase58Length(value) === 64; }
function detached(value) { return cloneAndFreezePlainDataV1(value, 'invalid_acquisition_request'); }

export function validateHeliusRpcGenesisResponseV1(value) {
  const result = rpcResult(value);
  if (typeof result !== 'string') malformed();
  if (result !== SOLANA_MAINNET_GENESIS_HASH) failWalletAcquisitionOperationV1('chain_identity_mismatch');
  return detached({ chain: 'solana', network: 'mainnet-beta', genesis_hash: result });
}
export function validateHeliusRpcSlotResponseV1(value) {
  const result = rpcResult(value);
  if (!safeInteger(result)) malformed();
  return result;
}
export function validateHeliusRpcBlockResponseV1(value, requestedSlot) {
  if (!safeInteger(requestedSlot)) malformed();
  const result = rpcResult(value);
  if (result === null) return null;
  object(result);
  if (Object.hasOwn(result, 'slot') && result.slot !== requestedSlot) malformed();
  if (!safeInteger(result.blockTime) || !isSolanaPublicKeyV1(result.blockhash)) malformed();
  return detached({ slot: requestedSlot, block_time: result.blockTime, blockhash: result.blockhash, commitment: 'finalized' });
}

function denseArray(value) {
  safePlain(value);
  if (!Array.isArray(value) || value.length > 100) malformed();
  return value;
}
export function validateHeliusRpcSignaturePageResponseV1(value) {
  const result = denseArray(rpcResult(value));
  const output = [];
  for (const entry of result) {
    object(entry);
    const fields = ['signature','slot','blockTime','err','memo','confirmationStatus'];
    if (Object.keys(entry).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(entry, key))) malformed();
    if (!isSolanaSignatureV1(entry.signature) || !safeInteger(entry.slot) || !safeInteger(entry.blockTime) || entry.confirmationStatus !== 'finalized') malformed();
    output.push({ signature: entry.signature, slot: entry.slot, block_time: entry.blockTime, execution_state: entry.err === null ? 'succeeded' : 'failed' });
  }
  return detached(output);
}

export function validateHeliusEnhancedAddressPageV1(value) {
  const page = denseArray(value);
  const output = [];
  for (const entry of page) {
    object(entry);
    if (!isSolanaSignatureV1(entry.signature) || !safeInteger(entry.slot) || !safeInteger(entry.timestamp) || !Object.hasOwn(entry, 'transactionError')) malformed();
    output.push(entry);
  }
  return detached(output);
}
