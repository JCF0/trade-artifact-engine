import { createPublicKey, verify } from 'node:crypto';

import { canonicalJson, fail } from '../contract.mjs';

const PUBLIC_KEY = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function domainSeparatedCanonicalBytesV1(domain, value) {
  if (typeof domain !== 'string' || !/^[A-Z0-9_]{8,96}$/.test(domain)) {
    fail('bounded_agent_authentication_domain_invalid', 'authentication domain is invalid');
  }
  return Buffer.concat([Buffer.from(`${domain}\0`, 'utf8'), Buffer.from(canonicalJson(value), 'utf8')]);
}

export function verifyEd25519DomainSignatureV1({ domain, value, public_key, signature }) {
  if (typeof public_key !== 'string' || !PUBLIC_KEY.test(public_key)) {
    fail('bounded_agent_authentication_public_key_invalid', 'Ed25519 public key must be 32 canonical bytes');
  }
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    fail('bounded_agent_authentication_signature_invalid', 'Ed25519 signature must be 64 canonical bytes');
  }
  let valid = false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(public_key, 'hex')]),
      format: 'der', type: 'spki',
    });
    valid = verify(null, domainSeparatedCanonicalBytesV1(domain, value), key, Buffer.from(signature, 'hex'));
  } catch {
    valid = false;
  }
  if (!valid) fail('bounded_agent_authentication_signature_invalid', 'Ed25519 domain signature is invalid');
  return true;
}
