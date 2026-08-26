/*
 * Generate a BLS12-381 issuer keypair. Run with: node tools/make-keypair.mjs
 *
 * Prints a secret key and its matching public key. The secret key signs cards;
 * the public key is the trust anchor a verifier needs and is what goes into
 * js/issuer-key.js.
 */

import './browser-shim.mjs';
import { nobleBLS } from '../js/lib/noble-bls.js';
import { randomSecretKey, publicKeyFromSecret, hexToBytes, bytesToHex } from '../js/payload.js';

const secretKey = process.argv[2] ?? randomSecretKey();
const publicKey = publicKeyFromSecret(secretKey);

// Prove the pair actually works before anyone writes it down.
const probe = 'MV1#probe';
const signature = await nobleBLS.sign(bytesToHex(new TextEncoder().encode(probe)), hexToBytes(secretKey));
const signatureHex = typeof signature === 'string' ? signature : bytesToHex(signature);
const verified = await nobleBLS.verify(signatureHex, bytesToHex(new TextEncoder().encode(probe)), hexToBytes(publicKey));

console.log('secret key (32 bytes, keep private):');
console.log(`  ${secretKey}`);
console.log('public key (48 bytes, distribute freely):');
console.log(`  ${publicKey}`);
console.log(`signature length: ${signatureHex.length} hex chars`);
console.log(`round-trip verify: ${verified ? 'OK' : 'FAILED'}`);

process.exit(verified ? 0 : 1);
