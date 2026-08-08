import { cloneAndFreezePlainDataV1 } from './errors.mjs';
import { SOLANA_MAINNET_GENESIS_HASH } from './request-contract.mjs';
import { detachProviderNeutralValueV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

function malformed(reason) { failWalletAcquisitionOperationV1('malformed_provider_response', reason); }
function safePlain(value) { detachProviderNeutralValueV1(value); }
function object(value, reason) { if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed(reason); return value; }
function rpcResult(value) {
  safePlain(value, 'rpc_envelope_invalid'); object(value, 'rpc_envelope_invalid');
  const keys = Object.keys(value);
  if (!keys.includes('jsonrpc') || !keys.includes('id') || !keys.includes('result') || keys.some(key => !['jsonrpc','id','result'].includes(key))
      || value.jsonrpc !== '2.0' || value.id !== 'wallet-acquisition-v1') malformed('rpc_envelope_invalid');
  return value.result;
}
function safeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
export { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';
function detached(value) { return cloneAndFreezePlainDataV1(value, 'invalid_acquisition_request'); }

export function validateHeliusRpcGenesisResponseV1(value) {
  const result = rpcResult(value);
  if (typeof result !== 'string') malformed('rpc_genesis_result_invalid');
  if (result !== SOLANA_MAINNET_GENESIS_HASH) failWalletAcquisitionOperationV1('chain_identity_mismatch');
  return detached({ chain: 'solana', network: 'mainnet-beta', genesis_hash: result });
}
export function validateHeliusRpcSlotResponseV1(value) {
  const result = rpcResult(value);
  if (!safeInteger(result)) malformed('rpc_slot_result_invalid');
  return result;
}
export function validateHeliusRpcBlockResponseV1(value, requestedSlot) {
  if (!safeInteger(requestedSlot)) malformed('rpc_block_result_invalid');
  const result = rpcResult(value);
  if (result === null) return null;
  object(result, 'rpc_block_result_invalid');
  if (Object.hasOwn(result, 'slot') && result.slot !== requestedSlot) malformed('rpc_block_result_invalid');
  if (!safeInteger(result.blockTime) || !isSolanaPublicKeyV1(result.blockhash)) malformed('rpc_block_result_invalid');
  return detached({ slot: requestedSlot, block_time: result.blockTime, blockhash: result.blockhash, commitment: 'finalized' });
}

function denseArray(value, reason) {
  safePlain(value, reason);
  if (!Array.isArray(value) || value.length > 100) malformed(reason);
  return value;
}
export function validateHeliusRpcSignaturePageResponseV1(value) {
  const reason = 'rpc_signature_page_invalid';
  const result = denseArray(rpcResult(value), reason);
  const output = [];
  for (const entry of result) {
    object(entry, reason);
    const fields = ['signature','slot','blockTime','err','memo','confirmationStatus'];
    if (Object.keys(entry).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(entry, key))) malformed(reason);
    if (!isSolanaSignatureV1(entry.signature) || !safeInteger(entry.slot) || !safeInteger(entry.blockTime) || entry.confirmationStatus !== 'finalized') malformed(reason);
    output.push({ signature: entry.signature, slot: entry.slot, block_time: entry.blockTime, execution_state: entry.err === null ? 'succeeded' : 'failed' });
  }
  return detached(output);
}

export function validateHeliusEnhancedAddressPageV1(value) {
  const reason = 'enhanced_page_invalid';
  const page = denseArray(value, reason);
  const output = [];
  for (const entry of page) {
    object(entry, reason);
    if (!isSolanaSignatureV1(entry.signature) || !safeInteger(entry.slot) || !safeInteger(entry.timestamp) || !Object.hasOwn(entry, 'transactionError')) malformed(reason);
    output.push(entry);
  }
  return detached(output);
}
