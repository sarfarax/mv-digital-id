'use strict';

/*
 * The signed payload carried by the QR code.
 *
 * Layout, following the '#'-separated convention of oelna/signed-qr-codes:
 *
 *   MV2#idNumber#name#sex#dob#expiry#address#photoHash#signature
 *   MV3#idNumber#name#sex#dob#expiry#address#photoHash#faceCode#signature
 *   \___________________ signed message ____________________/
 *
 * Everything before the signature is signed as one string, so neither a
 * printed field, the portrait nor the face code can be altered without
 * breaking the BLS signature. The whole thing is then LZString-compressed
 * before it is drawn as a barcode.
 *
 * MV2 is the Standard tier. MV3, the Enhanced tier, appends a face code so the
 * verifier can compare the person presenting the card, not just the printed
 * photograph. Both are current; the version prefix tells the reader how many
 * fields to expect and which checks apply.
 *
 * MV1 carried a phone number in the position now held by the expiry date.
 * Because the fields are positional, a reader that accepted both versions would
 * present an MV1 phone number as an expiry date, so MV1 is refused outright.
 */

import { nobleBLS } from './lib/noble-bls.js';
import { LZString } from './lib/lz-string.js';
import { qrcodegen } from './lib/qr-gen-lib.js';
import { isValidHash } from './phash.js';
import { isValidFaceCode, FACE_CODE_HEX } from './facecode.js';

export const SCHEMA_STANDARD = 'MV2';
export const SCHEMA_ENHANCED = 'MV3';
export const SUPPORTED_VERSIONS = [SCHEMA_STANDARD, SCHEMA_ENHANCED];
export const SEPARATOR = '#';

export const TIER_STANDARD = 'standard';
export const TIER_ENHANCED = 'enhanced';

export function tierOf(version) {
	return version === SCHEMA_ENHANCED ? TIER_ENHANCED : TIER_STANDARD;
}

export const FIELDS = [
	{ key: 'idNumber', label: 'ID Card Number', maxLength: 16 },
	{ key: 'name', label: 'Name', maxLength: 60 },
	{ key: 'sex', label: 'Sex', maxLength: 1 },
	{ key: 'dob', label: 'Date of Birth', maxLength: 10 },
	{ key: 'expiry', label: 'Expiry Date', maxLength: 10 },
	{ key: 'address', label: 'Permanent Address', maxLength: 80 }
];

export const FIELD_KEYS = FIELDS.map(field => field.key);

/* ------------------------------------------------------------------ *
 * Byte and hex helpers
 * ------------------------------------------------------------------ */

export function hexToBytes(hex) {
	const clean = hex.replace(/\s+/g, '');
	if (clean.length % 2 !== 0) throw new Error('hex string must have an even length');
	const bytes = new Uint8Array(clean.length / 2);
	for (let i = 0; i < clean.length; i += 2) {
		const byte = Number.parseInt(clean.substr(i, 2), 16);
		if (Number.isNaN(byte)) throw new Error(`invalid hex at offset ${i}`);
		bytes[i / 2] = byte;
	}
	return bytes;
}

export function bytesToHex(bytes) {
	let hex = '';
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
	return hex;
}

/*
 * The upstream demo encodes each UTF-16 code unit as four hex digits. UTF-8 is
 * used here instead: it is shorter for ASCII, and it round-trips Thaana and
 * emoji without surrogate handling. Only consistency between signing and
 * verification matters, and both call this.
 */
export function textToHex(text) {
	return bytesToHex(new TextEncoder().encode(text));
}

export function chunkHex(hex, size = 2, glue = ' ') {
	return hex.replace(new RegExp(`(.{${size}})`, 'g'), `$1${glue}`).trim();
}

export function randomSecretKey() {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	// BLS private keys must be below the curve order; clearing the top byte keeps
	// the value comfortably in range without needing modular reduction here.
	bytes[0] = bytes[0] % 0x40;
	return bytesToHex(bytes);
}

/* ------------------------------------------------------------------ *
 * Field handling
 * ------------------------------------------------------------------ */

/*
 * '#' delimits fields, so it can never appear inside one. Rather than invent an
 * escaping scheme that both sides must agree on, the character is simply
 * stripped at input time, along with collapsed whitespace and newlines — the
 * permanent address is a single line by definition.
 */
export function sanitizeField(value) {
	return String(value ?? '')
		.replace(/[#\r\n\t]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function sanitizeFields(fields) {
	const out = {};
	for (const { key } of FIELDS) out[key] = sanitizeField(fields[key]);
	return out;
}

/*
 * Dates are handled in UTC throughout. A card is not "expired" at midnight in
 * one timezone and valid in another, and comparing against a local-time parse
 * would make a card near its expiry read differently either side of a border.
 *
 * @returns {number|null} milliseconds at midnight UTC, or null if unparsable
 */
export function parseIsoDate(value) {
	const text = String(value ?? '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
	const time = Date.parse(`${text}T00:00:00Z`);
	if (Number.isNaN(time)) return null;
	// Date.parse accepts 2025-02-30 and rolls it into March; reject that.
	if (new Date(time).toISOString().slice(0, 10) !== text) return null;
	return time;
}

const DAY_MS = 86400000;

/**
 * Judge a card's expiry date. A card stays valid to the end of the day printed
 * on it, so an expiry of today is still good today.
 *
 * @param {string} expiry the expiry field, expected as YYYY-MM-DD
 * @param {number} [at] the moment to judge against, defaulting to now
 * @returns {{state: 'valid'|'expired'|'unreadable', daysRemaining: number|null}}
 */
export function expiryStatus(expiry, at = Date.now()) {
	const midnight = parseIsoDate(expiry);
	if (midnight === null) return { state: 'unreadable', daysRemaining: null };

	const endOfDay = midnight + DAY_MS - 1;
	return {
		state: at > endOfDay ? 'expired' : 'valid',
		daysRemaining: Math.ceil((endOfDay - at) / DAY_MS)
	};
}

export function validateFields(fields) {
	const errors = {};
	const clean = sanitizeFields(fields);

	if (!clean.idNumber) errors.idNumber = 'ID card number is required';
	else if (!/^[A-Za-z]\d{6}$/.test(clean.idNumber)) errors.idNumber = 'Expected a letter followed by six digits, for example A123456';

	if (!clean.name) errors.name = 'Name is required';

	if (!['M', 'F'].includes(clean.sex.toUpperCase())) errors.sex = 'Select a value';

	if (parseIsoDate(clean.dob) === null) errors.dob = 'Use the format YYYY-MM-DD';
	else if (parseIsoDate(clean.dob) > Date.now()) errors.dob = 'Date of birth is in the future';

	const expiry = expiryStatus(clean.expiry);
	if (expiry.state === 'unreadable') errors.expiry = 'Use the format YYYY-MM-DD';
	else if (expiry.state === 'expired') errors.expiry = 'Expiry date is already in the past';

	if (!clean.address) errors.address = 'Permanent address is required';

	for (const { key, label, maxLength } of FIELDS) {
		if (clean[key].length > maxLength) errors[key] = `${label} must be ${maxLength} characters or fewer`;
	}

	return { clean, errors, valid: Object.keys(errors).length === 0 };
}

/* ------------------------------------------------------------------ *
 * Message assembly
 * ------------------------------------------------------------------ */

/**
 * Build the signed portion: version, the six fields, the photo hash and, for
 * an Enhanced card, the face code. Passing a face code is what selects MV3.
 */
export function buildMessage(fields, photoHash, faceCode = null) {
	if (!isValidHash(photoHash)) throw new Error('photoHash must be 16 lowercase hex characters');
	if (faceCode !== null && !isValidFaceCode(faceCode)) {
		throw new Error(`faceCode must be ${FACE_CODE_HEX} lowercase hex characters`);
	}
	const clean = sanitizeFields(fields);
	const values = FIELD_KEYS.map(key => clean[key]);
	return faceCode === null
		? [SCHEMA_STANDARD, ...values, photoHash].join(SEPARATOR)
		: [SCHEMA_ENHANCED, ...values, photoHash, faceCode].join(SEPARATOR);
}

/** Split a signed message back into its parts. Throws if it is malformed. */
export function parseMessage(message) {
	const parts = String(message).split(SEPARATOR);
	const version = parts[0];
	if (!SUPPORTED_VERSIONS.includes(version)) throw new Error(`unsupported schema version "${version}"`);

	const enhanced = version === SCHEMA_ENHANCED;
	const expected = FIELD_KEYS.length + (enhanced ? 3 : 2);
	if (parts.length !== expected) {
		throw new Error(`expected ${expected} '#'-separated parts for ${version}, found ${parts.length}`);
	}

	const rest = parts.slice(1);
	const faceCode = enhanced ? rest.pop() : null;
	if (enhanced && !isValidFaceCode(faceCode)) throw new Error(`face code is not ${FACE_CODE_HEX} hex characters`);

	const photoHash = rest.pop();
	if (!isValidHash(photoHash)) throw new Error('photo hash is not 16 hex characters');

	const fields = {};
	FIELD_KEYS.forEach((key, index) => { fields[key] = rest[index]; });
	return { version, tier: tierOf(version), fields, photoHash, faceCode };
}

/** Split barcode text into the signed message and its trailing signature. */
export function splitBarcodeData(barcodeData) {
	const parts = String(barcodeData).split(SEPARATOR);
	const signature = parts.pop();
	return { message: parts.join(SEPARATOR), signature };
}

export function joinBarcodeData(message, signature) {
	return message + SEPARATOR + signature;
}

/* ------------------------------------------------------------------ *
 * Signing
 * ------------------------------------------------------------------ */

export function publicKeyFromSecret(secretKeyHex) {
	return bytesToHex(nobleBLS.getPublicKey(hexToBytes(secretKeyHex)));
}

export async function signMessage(message, secretKeyHex) {
	const signature = await nobleBLS.sign(textToHex(message), hexToBytes(secretKeyHex));
	return typeof signature === 'string' ? signature : bytesToHex(signature);
}

export async function verifyMessage(message, signatureHex, publicKeyHex) {
	try {
		return await nobleBLS.verify(signatureHex, textToHex(message), hexToBytes(publicKeyHex));
	} catch (error) {
		// A malformed signature or key throws rather than returning false; from a
		// verifier's point of view that is simply a failed check.
		console.warn('BLS verification error:', error);
		return false;
	}
}

/* ------------------------------------------------------------------ *
 * Barcode encoding
 * ------------------------------------------------------------------ */

export const ENCODING_BINARY = 'binary';
export const ENCODING_TEXT = 'text';

/**
 * Compress the barcode string and wrap it in a QR code.
 *
 * `binary` mode is the smaller of the two and matches the upstream demo. `text`
 * mode trades roughly a third more payload for a URL-safe ASCII body that
 * survives any reader, including ones that mangle raw byte-mode data.
 */
export function encodeBarcode(barcodeData, mode = ENCODING_BINARY) {
	if (mode === ENCODING_TEXT) {
		const text = LZString.compressToEncodedURIComponent(barcodeData);
		return {
			mode,
			text,
			byteLength: text.length,
			qr: qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.LOW)
		};
	}

	const bytes = LZString.compressToUint8Array(barcodeData);
	return {
		mode,
		bytes,
		byteLength: bytes.length,
		qr: qrcodegen.QrCode.encodeBinary(bytes, qrcodegen.QrCode.Ecc.LOW)
	};
}

function looksLikePayload(value) {
	return typeof value === 'string' && SUPPORTED_VERSIONS.some(version => value.startsWith(version + SEPARATOR));
}

/**
 * Recover the barcode string from a jsQR result, trying both encodings.
 *
 * Byte-mode QR data can come back through `binaryData` or, if the reader
 * decided the bytes were text, through `data`; rather than trusting either,
 * both are attempted and whichever decompresses into a well-formed payload
 * wins.
 */
export function decodeBarcode(code) {
	const attempts = [];

	if (code.binaryData && code.binaryData.length) {
		attempts.push([ENCODING_BINARY, () => LZString.decompressFromUint8Array(Uint8Array.from(code.binaryData))]);
	}
	if (typeof code.data === 'string' && code.data.length) {
		attempts.push([ENCODING_TEXT, () => LZString.decompressFromEncodedURIComponent(code.data)]);
		// A payload short enough to skip compression, or one from a reader that
		// handed back the plain string.
		attempts.push(['plain', () => code.data]);
	}

	for (const [mode, decode] of attempts) {
		let value;
		try {
			value = decode();
		} catch {
			continue;
		}
		if (looksLikePayload(value)) return { mode, barcodeData: value };
	}
	return null;
}

/** Decode, verify and parse in one step. Never throws. */
export async function readAndVerify(code, publicKeyHex) {
	const decoded = decodeBarcode(code);
	if (!decoded) return { ok: false, stage: 'decode', error: 'The QR code does not contain a Maldives digital ID payload.' };

	const { message, signature } = splitBarcodeData(decoded.barcodeData);
	if (!signature) return { ok: false, stage: 'decode', error: 'The payload has no signature attached.' };

	let parsed;
	try {
		parsed = parseMessage(message);
	} catch (error) {
		return { ok: false, stage: 'parse', error: `Malformed payload: ${error.message}`, barcodeData: decoded.barcodeData };
	}

	const signatureValid = await verifyMessage(message, signature, publicKeyHex);

	return {
		ok: signatureValid,
		stage: signatureValid ? 'verified' : 'signature',
		error: signatureValid ? null : 'The signature does not match. The data has been altered or was not issued by this authority.',
		mode: decoded.mode,
		barcodeData: decoded.barcodeData,
		message,
		signature,
		version: parsed.version,
		tier: parsed.tier,
		fields: parsed.fields,
		photoHash: parsed.photoHash,
		faceCode: parsed.faceCode
	};
}
