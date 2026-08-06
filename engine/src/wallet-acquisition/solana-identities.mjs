const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function decodedBase58ByteLengthV1(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const bytes = [0];
  for (const character of value) {
    let carry = BASE58_ALPHABET.indexOf(character);
    if (carry < 0) return null;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === '1') leadingZeroBytes += 1;
  const nonzeroByteLength = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  return leadingZeroBytes + nonzeroByteLength;
}

export function isSolanaPublicKeyV1(value) {
  return decodedBase58ByteLengthV1(value) === 32;
}

export function isSolanaSignatureV1(value) {
  return decodedBase58ByteLengthV1(value) === 64;
}
