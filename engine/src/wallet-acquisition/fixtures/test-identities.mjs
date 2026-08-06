import { isSolanaPublicKeyV1, isSolanaSignatureV1 } from '../solana-identities.mjs';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function encodeBase58(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  for (const byte of bytes) { if (byte === 0) digits.push(0); else break; }
  return digits.reverse().map(digit => BASE58[digit]).join('');
}
function derivedIdentity(label, size) {
  const text = String(label);
  const bytes = Array.from({ length: size }, (_, index) => ((text.charCodeAt(index % text.length) || 1) + (index * 29)) & 0xff);
  return encodeBase58(bytes);
}
export function providerSignature(label) { return isSolanaSignatureV1(label) ? label : derivedIdentity(label, 64); }
export function providerPublicKey(label) { return isSolanaPublicKeyV1(label) ? label : derivedIdentity(label, 32); }
