import { detachProviderNeutralValueV1, failWalletAcquisitionOperationV1 } from './provider-port.mjs';
import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from './solana-identities.mjs';

export const SOLANA_FULL_TRANSACTION_VERSION_V1 = 'solana_full_transaction_v1';

const TOP_FIELDS = [
  'full_transaction_version','signature','slot','block_time','execution_state','transaction_version',
  'fee_payer','fee_lamports','accounts','pre_lamport_balances','post_lamport_balances',
  'pre_token_balances','post_token_balances','instructions','inner_instruction_groups',
];
const ACCOUNT_FIELDS = ['address','is_signer','is_writable','source'];
const TOKEN_BALANCE_FIELDS = ['account_index','account','mint','owner','raw_amount','decimals','token_program'];
const INSTRUCTION_FIELDS = ['instruction_index','program_id','accounts','data'];
const INNER_GROUP_FIELDS = ['outer_instruction_index','instructions'];
const ACCOUNT_SOURCES = new Set(['static','lookup_writable','lookup_readonly']);
const RAW_AMOUNT = /^(?:0|[1-9][0-9]*)$/;
const MAX_U64 = 18_446_744_073_709_551_615n;
const BASE58_DATA = /^[1-9A-HJ-NP-Za-km-z]*$/;
const MAX_INSTRUCTION_DATA_LENGTH = 1_048_576;

function malformed() {
  failWalletAcquisitionOperationV1('malformed_provider_response', 'full_transaction_shape_invalid');
}

function exact(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed();
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key))
      || fields.some(key => !Object.hasOwn(value, key))) malformed();
}

function array(value) {
  if (!Array.isArray(value)) malformed();
  return value;
}

function safeNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateAccount(account) {
  exact(account, ACCOUNT_FIELDS);
  if (!isSolanaPublicKeyV1(account.address) || typeof account.is_signer !== 'boolean'
      || typeof account.is_writable !== 'boolean' || !ACCOUNT_SOURCES.has(account.source)) malformed();
  if (account.source === 'lookup_writable' && (!account.is_writable || account.is_signer)) malformed();
  if (account.source === 'lookup_readonly' && (account.is_writable || account.is_signer)) malformed();
}

function validateTokenBalances(rows, accounts) {
  const seen = new Set();
  let priorIndex = -1;
  for (const row of array(rows)) {
    exact(row, TOKEN_BALANCE_FIELDS);
    if (!safeNonnegativeInteger(row.account_index) || row.account_index >= accounts.length
        || row.account_index <= priorIndex || seen.has(row.account_index)
        || row.account !== accounts[row.account_index].address
        || !isSolanaPublicKeyV1(row.account) || !isSolanaPublicKeyV1(row.mint)
        || (row.owner !== null && !isSolanaPublicKeyV1(row.owner))
        || typeof row.raw_amount !== 'string' || row.raw_amount.length > 20 || !RAW_AMOUNT.test(row.raw_amount)
        || !safeNonnegativeInteger(row.decimals) || row.decimals > 255
        || !isSolanaPublicKeyV1(row.token_program)) malformed();
    try { if (BigInt(row.raw_amount) > MAX_U64) malformed(); } catch { malformed(); }
    seen.add(row.account_index);
    priorIndex = row.account_index;
  }
  return new Map(rows.map(row => [row.account_index, row]));
}

function validateInstruction(instruction, instructionIndex, accountSet) {
  exact(instruction, INSTRUCTION_FIELDS);
  if (instruction.instruction_index !== instructionIndex || !isSolanaPublicKeyV1(instruction.program_id)
      || typeof instruction.data !== 'string' || instruction.data.length > MAX_INSTRUCTION_DATA_LENGTH
      || !BASE58_DATA.test(instruction.data)) malformed();
  for (const account of array(instruction.accounts)) {
    if (!isSolanaPublicKeyV1(account) || !accountSet.has(account)) malformed();
  }
}

function validateDetached(transaction) {
  exact(transaction, TOP_FIELDS);
  if (transaction.full_transaction_version !== SOLANA_FULL_TRANSACTION_VERSION_V1
      || !isSolanaSignatureV1(transaction.signature) || !safeNonnegativeInteger(transaction.slot)
      || !safeNonnegativeInteger(transaction.block_time)
      || !['succeeded','failed'].includes(transaction.execution_state)
      || !['legacy', 0].includes(transaction.transaction_version)
      || !isSolanaPublicKeyV1(transaction.fee_payer)
      || !safeNonnegativeInteger(transaction.fee_lamports)) malformed();

  const accounts = array(transaction.accounts);
  if (accounts.length === 0) malformed();
  for (const account of accounts) validateAccount(account);
  const accountAddresses = accounts.map(account => account.address);
  if (new Set(accountAddresses).size !== accountAddresses.length
      || accounts[0].address !== transaction.fee_payer || accounts[0].is_signer !== true
      || accounts[0].is_writable !== true
      || accounts.some((account, index) => index > 0 && account.source === 'static' && accounts[index - 1].source !== 'static')
      || accounts.some((account, index) => account.source === 'lookup_writable' && accounts.slice(0, index).some(prior => prior.source === 'lookup_readonly'))) malformed();

  for (const balances of [transaction.pre_lamport_balances, transaction.post_lamport_balances]) {
    if (!Array.isArray(balances) || balances.length !== accounts.length
        || balances.some(balance => !safeNonnegativeInteger(balance))) malformed();
  }

  const preTokens = validateTokenBalances(transaction.pre_token_balances, accounts);
  const postTokens = validateTokenBalances(transaction.post_token_balances, accounts);
  for (const [accountIndex, pre] of preTokens) {
    const post = postTokens.get(accountIndex);
    if (post !== undefined && (pre.account !== post.account || pre.mint !== post.mint || pre.owner !== post.owner
        || pre.decimals !== post.decimals || pre.token_program !== post.token_program)) malformed();
  }

  const accountSet = new Set(accountAddresses);
  const instructions = array(transaction.instructions);
  instructions.forEach((instruction, index) => validateInstruction(instruction, index, accountSet));

  let priorOuterIndex = -1;
  for (const group of array(transaction.inner_instruction_groups)) {
    exact(group, INNER_GROUP_FIELDS);
    if (!safeNonnegativeInteger(group.outer_instruction_index)
        || group.outer_instruction_index >= instructions.length
        || group.outer_instruction_index <= priorOuterIndex) malformed();
    array(group.instructions).forEach((instruction, index) => validateInstruction(instruction, index, accountSet));
    priorOuterIndex = group.outer_instruction_index;
  }
  return true;
}

export function validateSolanaFullTransactionV1(transaction) {
  const detached = detachProviderNeutralValueV1(transaction);
  return validateDetached(detached);
}

export function buildSolanaFullTransactionV1(transaction) {
  const detached = detachProviderNeutralValueV1(transaction);
  validateDetached(detached);
  return detached;
}
