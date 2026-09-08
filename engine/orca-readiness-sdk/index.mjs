// Isolated pinned SDK runtime; no runner, transport, signer or credential access.
import {
  getWhirlpoolDecoder, getWhirlpoolDiscriminatorBytes, getWhirlpoolSize,
  getFixedTickArrayDecoder, getFixedTickArrayDiscriminatorBytes, getFixedTickArraySize,
} from '@orca-so/whirlpools-client';
export { getWhirlpoolDecoder, getTickArrayDecoder } from '@orca-so/whirlpools-client';
export { swapQuoteByInputToken } from '@orca-so/whirlpools-core';

function decodeFixed(bytes, size, discriminator, decoder) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== size
      || !discriminator.every((value, index) => bytes[index] === value)) {
    throw new Error('route account layout/discriminator invalid');
  }
  return decoder.decode(bytes);
}
export function decodeFixedWhirlpoolV1(bytes) {
  return decodeFixed(bytes, getWhirlpoolSize(), getWhirlpoolDiscriminatorBytes(), getWhirlpoolDecoder());
}
export function decodeFixedTickArrayV1(bytes) {
  return decodeFixed(bytes, getFixedTickArraySize(), getFixedTickArrayDiscriminatorBytes(), getFixedTickArrayDecoder());
}
