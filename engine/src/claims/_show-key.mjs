import { readFileSync } from 'fs';
import { Keypair } from '@solana/web3.js';
const path = process.argv[2] || '../../devnet-vault.json';
const k = Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, 'utf-8'))));
console.log(k.publicKey.toBase58());
