import { buildSolanaFullTransactionV1 } from './solana-full-transaction.mjs';
import { detachProviderNeutralValueV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

const HEADER_FIELDS = ['numRequiredSignatures','numReadonlySignedAccounts','numReadonlyUnsignedAccounts'];
const LOOKUP_FIELDS = ['accountKey','writableIndexes','readonlyIndexes'];
const BASE58_DATA = /^[1-9A-HJ-NP-Za-km-z]*$/;
const RAW_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const MAX_INSTRUCTION_DATA_LENGTH = 1_048_576;

function malformed(reason = 'full_transaction_shape_invalid') {
  failWalletAcquisitionOperationV1('malformed_provider_response', reason);
}

function object(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed();
  return value;
}

function array(value) {
  if (!Array.isArray(value)) malformed();
  return value;
}

function exact(value, fields) {
  object(value);
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(value, key))) malformed();
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateHeader(value, staticAccountCount) {
  exact(value, HEADER_FIELDS);
  for (const field of HEADER_FIELDS) if (!safeNonnegativeInteger(value[field])) malformed();
  if (value.numRequiredSignatures < 1 || value.numRequiredSignatures > staticAccountCount
      || value.numReadonlySignedAccounts > value.numRequiredSignatures
      || value.numReadonlyUnsignedAccounts > staticAccountCount - value.numRequiredSignatures) malformed();
  return value;
}

function resolveAccounts(message, meta, version, signatureCount) {
  const staticKeys = array(message.accountKeys);
  if (staticKeys.length === 0 || staticKeys.some(key => !isSolanaPublicKeyV1(key))) malformed();
  const header = validateHeader(message.header, staticKeys.length);
  if (signatureCount !== header.numRequiredSignatures) malformed();
  const lookups = message.addressTableLookups === undefined ? [] : array(message.addressTableLookups);
  let expectedWritable = 0;
  let expectedReadonly = 0;
  for (const lookup of lookups) {
    exact(lookup, LOOKUP_FIELDS);
    if (!isSolanaPublicKeyV1(lookup.accountKey)) malformed();
    for (const index of array(lookup.writableIndexes)) {
      if (!safeNonnegativeInteger(index) || index > 255) malformed();
      expectedWritable += 1;
    }
    for (const index of array(lookup.readonlyIndexes)) {
      if (!safeNonnegativeInteger(index) || index > 255) malformed();
      expectedReadonly += 1;
    }
  }

  let loadedWritable = [];
  let loadedReadonly = [];
  if (version === 0) {
    object(meta.loadedAddresses);
    loadedWritable = array(meta.loadedAddresses.writable);
    loadedReadonly = array(meta.loadedAddresses.readonly);
    if (Object.keys(meta.loadedAddresses).length !== 2
        || loadedWritable.length !== expectedWritable || loadedReadonly.length !== expectedReadonly) malformed();
  } else {
    if (lookups.length !== 0) malformed();
    if (meta.loadedAddresses !== undefined) {
      object(meta.loadedAddresses);
      if (Object.keys(meta.loadedAddresses).length !== 2
          || array(meta.loadedAddresses.writable).length !== 0
          || array(meta.loadedAddresses.readonly).length !== 0) malformed();
    }
  }
  if ([...loadedWritable, ...loadedReadonly].some(key => !isSolanaPublicKeyV1(key))) malformed();

  const writableSigned = header.numRequiredSignatures - header.numReadonlySignedAccounts;
  const writableUnsignedEnd = staticKeys.length - header.numReadonlyUnsignedAccounts;
  return [
    ...staticKeys.map((address, index) => ({
      address,
      is_signer: index < header.numRequiredSignatures,
      is_writable: index < header.numRequiredSignatures ? index < writableSigned : index < writableUnsignedEnd,
      source: 'static',
    })),
    ...loadedWritable.map(address => ({ address, is_signer: false, is_writable: true, source: 'lookup_writable' })),
    ...loadedReadonly.map(address => ({ address, is_signer: false, is_writable: false, source: 'lookup_readonly' })),
  ];
}

function normalizeTokenBalances(rows, accounts) {
  return array(rows).map(row => {
    object(row);
    object(row.uiTokenAmount);
    if (!safeNonnegativeInteger(row.accountIndex) || row.accountIndex >= accounts.length
        || !isSolanaPublicKeyV1(row.mint) || (Object.hasOwn(row, 'owner') && row.owner !== null && !isSolanaPublicKeyV1(row.owner))
        || !isSolanaPublicKeyV1(row.programId) || typeof row.uiTokenAmount.amount !== 'string'
        || !RAW_AMOUNT.test(row.uiTokenAmount.amount) || !safeNonnegativeInteger(row.uiTokenAmount.decimals)
        || row.uiTokenAmount.decimals > 255) malformed();
    return {
      account_index: row.accountIndex,
      account: accounts[row.accountIndex].address,
      mint: row.mint,
      owner: Object.hasOwn(row, 'owner') ? row.owner : null,
      raw_amount: row.uiTokenAmount.amount,
      decimals: row.uiTokenAmount.decimals,
      token_program: row.programId,
    };
  });
}

function normalizeInstruction(instruction, instructionIndex, accounts) {
  object(instruction);
  if (!safeNonnegativeInteger(instruction.programIdIndex) || instruction.programIdIndex >= accounts.length
      || typeof instruction.data !== 'string' || instruction.data.length > MAX_INSTRUCTION_DATA_LENGTH
      || !BASE58_DATA.test(instruction.data)) malformed();
  const resolvedAccounts = array(instruction.accounts).map(index => {
    if (!safeNonnegativeInteger(index) || index >= accounts.length) malformed();
    return accounts[index].address;
  });
  return {
    instruction_index: instructionIndex,
    program_id: accounts[instruction.programIdIndex].address,
    accounts: resolvedAccounts,
    data: instruction.data,
  };
}

export function validateHeliusFullTransactionV1(value, requestedSignature) {
  const raw = detachProviderNeutralValueV1(value);
  if (!isSolanaSignatureV1(requestedSignature)) malformed();
  object(raw);
  if (!safeNonnegativeInteger(raw.slot) || !safeNonnegativeInteger(raw.blockTime)
      || !['legacy', 0].includes(raw.version)) malformed();
  const transaction = object(raw.transaction);
  const message = object(transaction.message);
  const meta = object(raw.meta);
  const signatures = array(transaction.signatures);
  if (signatures.length === 0 || signatures.some(signature => !isSolanaSignatureV1(signature))) malformed();
  if (signatures[0] !== requestedSignature) malformed('full_transaction_signature_mismatch');
  if (!Object.hasOwn(meta, 'err') || !safeNonnegativeInteger(meta.fee)) malformed();

  const accounts = resolveAccounts(message, meta, raw.version, signatures.length);
  const preLamports = array(meta.preBalances);
  const postLamports = array(meta.postBalances);
  if (preLamports.length !== accounts.length || postLamports.length !== accounts.length
      || preLamports.some(value => !safeNonnegativeInteger(value))
      || postLamports.some(value => !safeNonnegativeInteger(value))) malformed();

  const instructions = array(message.instructions)
    .map((instruction, index) => normalizeInstruction(instruction, index, accounts));
  const rawInnerGroups = meta.innerInstructions === null ? [] : array(meta.innerInstructions);
  const innerInstructionGroups = rawInnerGroups.map(group => {
    object(group);
    if (!safeNonnegativeInteger(group.index) || group.index >= instructions.length) malformed();
    return {
      outer_instruction_index: group.index,
      instructions: array(group.instructions).map((instruction, index) => normalizeInstruction(instruction, index, accounts)),
    };
  });

  return buildSolanaFullTransactionV1({
    full_transaction_version: 'solana_full_transaction_v1',
    signature: signatures[0],
    slot: raw.slot,
    block_time: raw.blockTime,
    execution_state: meta.err === null ? 'succeeded' : 'failed',
    transaction_version: raw.version,
    fee_payer: accounts[0].address,
    fee_lamports: meta.fee,
    accounts,
    pre_lamport_balances: preLamports,
    post_lamport_balances: postLamports,
    pre_token_balances: normalizeTokenBalances(meta.preTokenBalances, accounts),
    post_token_balances: normalizeTokenBalances(meta.postTokenBalances, accounts),
    instructions,
    inner_instruction_groups: innerInstructionGroups,
  });
}
