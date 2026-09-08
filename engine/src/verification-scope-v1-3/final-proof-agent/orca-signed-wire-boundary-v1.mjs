import { createHash, createPublicKey, verify } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { Message } from '@solana/web3.js';
import { fail } from '../contract.mjs';
import { encodeBase58 } from './reused/bounded-rebroadcast-v1.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function reject(message) { fail('bounded_agent_signed_wire_boundary_invalid', message); }
function privateRoot(root) {
  const st = lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(root) !== root
      || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) reject('private executor root required');
  return st;
}
export function verifyExactSignedWireV1(message, wire) {
  if (!Buffer.isBuffer(message) || !Buffer.isBuffer(wire) || wire.length > 1232
      || wire.length !== 65 + message.length || wire[0] !== 1
      || !wire.subarray(65).equals(message)) reject('signed message mismatch');
  const parsed = Message.from(message);
  if (parsed.header.numRequiredSignatures !== 1 || !Buffer.from(parsed.serialize()).equals(message)) {
    reject('message must be canonical one-signer legacy bytes');
  }
  const key = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), parsed.accountKeys[0].toBuffer(),
  ]), format: 'der', type: 'spki' });
  if (!verify(null, message, key, wire.subarray(1, 65))) reject('signature verification failed');
  return Object.freeze({ message_sha256: hash(message), signed_wire_sha256: hash(wire),
    signature: encodeBase58(wire.subarray(1, 65)) });
}
// Pure crypto/retention utility, NOT admission or signing authority. The composed
// adapter must first compare `message` to its privately constructed Orca plan.
export function retainExactSignedWireV1({ root, ordinal, message, wire }) {
  const identity = verifyExactSignedWireV1(message, wire);
  if (![1, 2].includes(ordinal)) reject('ordinal invalid');
  const before = privateRoot(root);
  const path = join(root, `orca-signed-wire-${ordinal}.bin`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < wire.length) {
      const n = writeSync(fd, wire, offset, wire.length - offset);
      if (n <= 0) reject('short signed wire write');
      offset += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(rootFd);
    if (st.dev !== before.dev || st.ino !== before.ino) reject('root identity changed');
    fsyncSync(rootFd);
  } finally { closeSync(rootFd); }
  const readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(readFd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0
        || st.size !== wire.length) reject('retained wire metadata mismatch');
    const after = privateRoot(root);
    if (before.dev !== after.dev || before.ino !== after.ino) reject('root identity changed');
    const retained = readFileSync(readFd);
    if (!retained.equals(wire)) reject('retained signed wire changed');
    verifyExactSignedWireV1(message, retained);
  } finally { closeSync(readFd); }
  return Object.freeze({ ...identity, signed_wire_path: path });
}
