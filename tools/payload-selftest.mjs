/*
 * End-to-end self-test for the signed payload. Run with:
 *   node tools/payload-selftest.mjs
 *
 * Exercises the same code paths the browser uses: build a message, sign it,
 * compress it into a barcode, then decode, verify and detect tampering.
 */

import './browser-shim.mjs';
import {
	FIELDS,
	buildMessage,
	parseMessage,
	signMessage,
	verifyMessage,
	publicKeyFromSecret,
	joinBarcodeData,
	splitBarcodeData,
	encodeBarcode,
	decodeBarcode,
	readAndVerify,
	sanitizeField,
	validateFields,
	expiryStatus,
	ENCODING_BINARY,
	ENCODING_TEXT
} from '../js/payload.js';
import { DEMO_SECRET_KEY, ISSUER } from '../js/issuer-key.js';

const results = [];
function check(label, ok, detail = '') {
	results.push(ok);
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(52)} ${detail}`);
}

// Expiry is relative so the fixture never rots into an invalid cardholder.
const isoDaysFromNow = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const cardholder = {
	idNumber: 'A123456',
	name: 'Aishath Nasheeda Ibrahim',
	sex: 'F',
	dob: '1991-04-17',
	expiry: isoDaysFromNow(3650),
	address: 'Ma. Blue Heaven, Male, Maldives'
};
const photoHash = '30b2e6c3d32d0bf4';

console.log('payload self-test\n');
console.log('issuer public key:', ISSUER.publicKey.slice(0, 24) + '...');

const derived = publicKeyFromSecret(DEMO_SECRET_KEY);
check('demo secret key derives the published public key', derived === ISSUER.publicKey);

console.log('\nfield handling:');
check("sanitize strips the '#' separator", sanitizeField('Ma. Blue # Heaven') === 'Ma. Blue Heaven');
check('sanitize collapses newlines into one line', sanitizeField('Line one\nLine two') === 'Line one Line two');
check('valid cardholder passes validation', validateFields(cardholder).valid);
check('bad ID number is rejected', !validateFields({ ...cardholder, idNumber: '12345' }).valid);
check('bad date of birth is rejected', !validateFields({ ...cardholder, dob: '17/04/1991' }).valid);
check('future date of birth is rejected', !validateFields({ ...cardholder, dob: '2999-01-01' }).valid);
check('impossible calendar date is rejected', !validateFields({ ...cardholder, dob: '1991-02-30' }).valid);
check('past expiry date is rejected at issue', !validateFields({ ...cardholder, expiry: isoDaysFromNow(-1) }).valid);
check('malformed expiry date is rejected', !validateFields({ ...cardholder, expiry: '17/04/2035' }).valid);

console.log('\nexpiry status:');
check('a future expiry reads as valid', expiryStatus(isoDaysFromNow(30)).state === 'valid');
check('a past expiry reads as expired', expiryStatus(isoDaysFromNow(-30)).state === 'expired');
check("today's expiry is still valid", expiryStatus(new Date().toISOString().slice(0, 10)).state === 'valid');
check('an unparsable expiry is flagged', expiryStatus('not-a-date').state === 'unreadable');

console.log('\nsigning:');
const message = buildMessage(cardholder, photoHash);
const signature = await signMessage(message, DEMO_SECRET_KEY);
check('signature is 192 hex characters', signature.length === 192, `${signature.length} chars`);
check('signature verifies against the public key', await verifyMessage(message, signature, ISSUER.publicKey));

const parsed = parseMessage(message);
check('round-tripped fields match', FIELDS.every(f => parsed.fields[f.key] === cardholder[f.key]));
check('round-tripped photo hash matches', parsed.photoHash === photoHash);

console.log('\nbarcode encoding:');
const barcodeData = joinBarcodeData(message, signature);
console.log(`  raw payload: ${barcodeData.length} characters`);

for (const mode of [ENCODING_BINARY, ENCODING_TEXT]) {
	const encoded = encodeBarcode(barcodeData, mode);
	const ratio = ((encoded.byteLength / barcodeData.length) * 100).toFixed(0);
	console.log(`  ${mode.padEnd(7)} -> ${String(encoded.byteLength).padStart(4)} bytes (${ratio}% of raw), QR version ${encoded.qr.version}, ${encoded.qr.size}x${encoded.qr.size} modules`);
	check(`${mode} QR fits within version 40`, encoded.qr.version <= 40);

	// Simulate what jsQR hands back for each mode.
	const code = mode === ENCODING_BINARY
		? { binaryData: Array.from(encoded.bytes), data: '' }
		: { binaryData: [], data: encoded.text };
	const decoded = decodeBarcode(code);
	check(`${mode} survives a decode round trip`, decoded?.barcodeData === barcodeData);
}

console.log('\nverification through the scanner path:');
const encoded = encodeBarcode(barcodeData, ENCODING_BINARY);
const goodCode = { binaryData: Array.from(encoded.bytes), data: '' };
const good = await readAndVerify(goodCode, ISSUER.publicKey);
check('genuine card is accepted', good.ok === true, good.error ?? '');
check('accepted card exposes the right name', good.fields?.name === cardholder.name);
check('accepted card exposes the photo hash', good.photoHash === photoHash);

console.log('\ntamper detection:');

async function tamper(label, mutate) {
	const mutated = mutate(barcodeData);
	const enc = encodeBarcode(mutated, ENCODING_BINARY);
	const result = await readAndVerify({ binaryData: Array.from(enc.bytes), data: '' }, ISSUER.publicKey);
	check(label, result.ok === false, `stage: ${result.stage}`);
}

await tamper('altered name is rejected', d => d.replace(cardholder.name, 'Mohamed Imposter Ali'));
await tamper('altered date of birth is rejected', d => d.replace(cardholder.dob, '2001-04-17'));
await tamper('altered address is rejected', d => d.replace('Blue Heaven', 'Gold Heaven'));
await tamper('swapped photo hash is rejected', d => d.replace(photoHash, 'ffffffffffffffff'));
await tamper('flipped signature byte is rejected', d => {
	const { message: m, signature: s } = splitBarcodeData(d);
	const flipped = (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
	return joinBarcodeData(m, flipped);
});

const wrongKey = publicKeyFromSecret('11'.repeat(32));
const wrongIssuer = await readAndVerify(goodCode, wrongKey);
check('card from another issuer is rejected', wrongIssuer.ok === false, `stage: ${wrongIssuer.stage}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
