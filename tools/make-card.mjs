/*
 * Render ready-made sample cards. Run with: node tools/make-card.mjs
 *
 * Produces four cards, so the scanner can be tried without a camera or a
 * printer. Drop samples/card-genuine.png on the verify page and it should pass;
 * samples/card-forged.png keeps the signature valid but fails the portrait
 * check; samples/card-expired.png passes both and is still refused for being
 * out of date; samples/card-tampered.png fails the signature.
 *
 * Portraits come from the real photographs in samples/portrait-*.jpg, exported
 * to greyscale 300x400 dumps (portrait-a.rgba / portrait-b.rgba) so hashing
 * matches the card that is printed. Those JPEGs are examples from Maldives
 * Immigration passport photo standards:
 * https://imuga.immigration.gov.mv/passport/photo-standards
 *
 * The card is rasterised directly rather than screenshotting the DOM, which
 * keeps this runnable from the command line. Only two things have to be exact:
 * the portrait and the QR must land precisely on the millimetre rectangles in
 * js/card.js, because that is what the scanner's homography assumes.
 */

import './browser-shim.mjs';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CARD, PORTRAIT_RECT, QR_RECT, QR_QUIET_ZONE } from '../js/card.js';
import { pHashHex } from '../js/phash.js';
import { buildMessage, signMessage, joinBarcodeData, encodeBarcode } from '../js/payload.js';
import { DEMO_SECRET_KEY, ISSUER } from '../js/issuer-key.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const PX_PER_MM = 16;
const WIDTH = Math.round(CARD.width * PX_PER_MM);
const HEIGHT = Math.round(CARD.height * PX_PER_MM);

function shiftYears(years, from = new Date()) {
	return new Date(Date.UTC(from.getUTCFullYear() + years, from.getUTCMonth(), from.getUTCDate()))
		.toISOString().slice(0, 10);
}

const CARDHOLDER = {
	idNumber: 'A123456',
	name: 'Aishath Nasheeda Ibrahim',
	sex: 'F',
	dob: '1991-04-17',
	expiry: shiftYears(10),
	address: 'Ma. Blue Heaven, Male, Maldives'
};

const EXPIRED_CARDHOLDER = { ...CARDHOLDER, expiry: shiftYears(-2) };

/* ------------------------------ PNG output ------------------------------ */

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buffer) {
	let c = 0xffffffff;
	for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed), 0);
	return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, rgb) {
	const raw = Buffer.alloc(height * (width * 3 + 1));
	for (let y = 0; y < height; y++) {
		const start = y * (width * 3 + 1);
		raw[start] = 0;
		rgb.copy(raw, start + 1, y * width * 3, (y + 1) * width * 3);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/* ------------------------------ Raster canvas ------------------------------ */

function createSurface(width, height, fill = [255, 255, 255]) {
	const data = Buffer.alloc(width * height * 3);
	for (let i = 0; i < width * height; i++) {
		data[i * 3] = fill[0];
		data[i * 3 + 1] = fill[1];
		data[i * 3 + 2] = fill[2];
	}
	return { data, width, height };
}

function fillRect(surface, x, y, w, h, colour) {
	const x0 = Math.max(0, Math.round(x));
	const y0 = Math.max(0, Math.round(y));
	const x1 = Math.min(surface.width, Math.round(x + w));
	const y1 = Math.min(surface.height, Math.round(y + h));
	for (let py = y0; py < y1; py++) {
		for (let px = x0; px < x1; px++) {
			const p = (py * surface.width + px) * 3;
			surface.data[p] = colour[0];
			surface.data[p + 1] = colour[1];
			surface.data[p + 2] = colour[2];
		}
	}
}

/* A 5x7 bitmap font, column-major with the least significant bit at the top. */
const FONT = {
	' ': [0x00, 0x00, 0x00, 0x00, 0x00], '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
	',': [0x00, 0x50, 0x30, 0x00, 0x00], '-': [0x08, 0x08, 0x08, 0x08, 0x08],
	'.': [0x00, 0x60, 0x60, 0x00, 0x00], '/': [0x20, 0x10, 0x08, 0x04, 0x02],
	'0': [0x3e, 0x51, 0x49, 0x45, 0x3e], '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
	'2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
	'4': [0x18, 0x14, 0x12, 0x7f, 0x10], '5': [0x27, 0x45, 0x45, 0x45, 0x39],
	'6': [0x3c, 0x4a, 0x49, 0x49, 0x30], '7': [0x01, 0x71, 0x09, 0x05, 0x03],
	'8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
	':': [0x00, 0x36, 0x36, 0x00, 0x00],
	A: [0x7e, 0x11, 0x11, 0x11, 0x7e], B: [0x7f, 0x49, 0x49, 0x49, 0x36],
	C: [0x3e, 0x41, 0x41, 0x41, 0x22], D: [0x7f, 0x41, 0x41, 0x22, 0x1c],
	E: [0x7f, 0x49, 0x49, 0x49, 0x41], F: [0x7f, 0x09, 0x09, 0x09, 0x01],
	G: [0x3e, 0x41, 0x49, 0x49, 0x7a], H: [0x7f, 0x08, 0x08, 0x08, 0x7f],
	I: [0x00, 0x41, 0x7f, 0x41, 0x00], J: [0x20, 0x40, 0x41, 0x3f, 0x01],
	K: [0x7f, 0x08, 0x14, 0x22, 0x41], L: [0x7f, 0x40, 0x40, 0x40, 0x40],
	M: [0x7f, 0x02, 0x0c, 0x02, 0x7f], N: [0x7f, 0x04, 0x08, 0x10, 0x7f],
	O: [0x3e, 0x41, 0x41, 0x41, 0x3e], P: [0x7f, 0x09, 0x09, 0x09, 0x06],
	Q: [0x3e, 0x41, 0x51, 0x21, 0x5e], R: [0x7f, 0x09, 0x19, 0x29, 0x46],
	S: [0x46, 0x49, 0x49, 0x49, 0x31], T: [0x01, 0x01, 0x7f, 0x01, 0x01],
	U: [0x3f, 0x40, 0x40, 0x40, 0x3f], V: [0x1f, 0x20, 0x40, 0x20, 0x1f],
	W: [0x7f, 0x20, 0x18, 0x20, 0x7f], X: [0x63, 0x14, 0x08, 0x14, 0x63],
	Y: [0x07, 0x08, 0x70, 0x08, 0x07], Z: [0x61, 0x51, 0x49, 0x45, 0x43]
};

function drawText(surface, text, x, y, scale, colour) {
	let cursor = x;
	for (const character of text.toUpperCase()) {
		const glyph = FONT[character] ?? FONT[' '];
		for (let column = 0; column < 5; column++) {
			for (let row = 0; row < 7; row++) {
				if (glyph[column] & (1 << row)) {
					fillRect(surface, cursor + column * scale, y + row * scale, scale, scale, colour);
				}
			}
		}
		cursor += 6 * scale;
	}
	return cursor;
}

function textWidth(text, scale) {
	return text.length * 6 * scale;
}

/** Pixel height of one glyph row at the given scale (5×7 font). */
function textHeight(scale) {
	return 7 * scale;
}

/**
 * Word-wrap for the bitmap font. Long tokens are hard-broken so names and
 * addresses stay inside the VIZ column when type is enlarged for print.
 */
function wrapText(text, scale, maxWidthPx) {
	const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
	const lines = [];
	let current = '';

	const pushHardBroken = (token) => {
		let chunk = '';
		for (const character of token) {
			const next = chunk + character;
			if (chunk && textWidth(next, scale) > maxWidthPx) {
				lines.push(chunk);
				chunk = character;
			} else {
				chunk = next;
			}
		}
		current = chunk;
	};

	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (!current || textWidth(next, scale) <= maxWidthPx) {
			current = next;
			continue;
		}
		lines.push(current);
		if (textWidth(word, scale) > maxWidthPx) pushHardBroken(word);
		else current = word;
	}
	if (current) lines.push(current);
	return lines.length ? lines : [''];
}

function drawWrapped(surface, text, x, y, scale, colour, maxWidthPx, lineGapPx = scale) {
	const lines = wrapText(text, scale, maxWidthPx);
	let cursorY = y;
	for (const line of lines) {
		drawText(surface, line, x, cursorY, scale, colour);
		cursorY += textHeight(scale) + lineGapPx;
	}
	return cursorY;
}

/* ------------------------------ Portraits ------------------------------ */

function loadPortraitRgba(name) {
	const buffer = readFileSync(join(OUT_DIR, name));
	const width = buffer.readUInt32BE(0);
	const height = buffer.readUInt32BE(4);
	return {
		width,
		height,
		data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + 8, width * height * 4)
	};
}

// Real photographs, centre-cropped to 3:4 and greyscaled to match the issuer.
const PORTRAITS = {
	a: loadPortraitRgba('portrait-a.rgba'), // portrait-2.jpg — female sample cardholder
	b: loadPortraitRgba('portrait-b.rgba')  // portrait-1.jpg — substituted face for forgery
};

function drawPortrait(surface, portrait, rect) {
	const x0 = Math.round(rect.x * PX_PER_MM);
	const y0 = Math.round(rect.y * PX_PER_MM);
	const w = Math.round(rect.width * PX_PER_MM);
	const h = Math.round(rect.height * PX_PER_MM);

	// Navy frame around the portrait — a camera-readable boundary.
	fillRect(surface, x0 - 2, y0 - 2, w + 4, h + 4, [12, 59, 124]);

	for (let y = 0; y < h; y++) {
		const sy = ((y + 0.5) / h) * portrait.height - 0.5;
		const sy0 = Math.max(0, Math.min(portrait.height - 1, Math.floor(sy)));
		const sy1 = Math.min(portrait.height - 1, sy0 + 1);
		const fy = Math.max(0, Math.min(1, sy - sy0));

		for (let x = 0; x < w; x++) {
			const sx = ((x + 0.5) / w) * portrait.width - 0.5;
			const sx0 = Math.max(0, Math.min(portrait.width - 1, Math.floor(sx)));
			const sx1 = Math.min(portrait.width - 1, sx0 + 1);
			const fx = Math.max(0, Math.min(1, sx - sx0));

			const at = (px, py) => portrait.data[(py * portrait.width + px) * 4];
			const value =
				(at(sx0, sy0) * (1 - fx) + at(sx1, sy0) * fx) * (1 - fy) +
				(at(sx0, sy1) * (1 - fx) + at(sx1, sy1) * fx) * fy;

			const p = ((y0 + y) * surface.width + (x0 + x)) * 3;
			surface.data[p] = surface.data[p + 1] = surface.data[p + 2] = Math.round(value);
		}
	}
}

function drawQr(surface, qr) {
	const x0 = Math.round(QR_RECT.x * PX_PER_MM);
	const y0 = Math.round(QR_RECT.y * PX_PER_MM);
	const size = Math.round(QR_RECT.width * PX_PER_MM);

	fillRect(surface,
		(QR_RECT.x - QR_QUIET_ZONE) * PX_PER_MM - 1,
		(QR_RECT.y - QR_QUIET_ZONE) * PX_PER_MM - 1,
		(QR_RECT.width + QR_QUIET_ZONE * 2) * PX_PER_MM + 2,
		(QR_RECT.height + QR_QUIET_ZONE * 2) * PX_PER_MM + 2,
		[12, 59, 124]);
	fillRect(surface,
		(QR_RECT.x - QR_QUIET_ZONE) * PX_PER_MM,
		(QR_RECT.y - QR_QUIET_ZONE) * PX_PER_MM,
		(QR_RECT.width + QR_QUIET_ZONE * 2) * PX_PER_MM,
		(QR_RECT.height + QR_QUIET_ZONE * 2) * PX_PER_MM,
		[255, 255, 255]);

	for (let y = 0; y < size; y++) {
		const moduleY = Math.floor((y / size) * qr.size);
		for (let x = 0; x < size; x++) {
			const moduleX = Math.floor((x / size) * qr.size);
			const dark = qr.getModule(moduleX, moduleY);
			const p = ((y0 + y) * surface.width + (x0 + x)) * 3;
			const tone = dark ? 0 : 255;
			surface.data[p] = surface.data[p + 1] = surface.data[p + 2] = tone;
		}
	}
}

function renderCard(portrait, qr, cardholder = CARDHOLDER) {
	const surface = createSurface(WIDTH, HEIGHT, [247, 249, 252]);
	const navy = [12, 59, 124];
	const navyDeep = [10, 50, 104];
	const gold = [240, 196, 25];
	const ink = [14, 26, 43];
	const label = [12, 59, 124];
	const headerH = 11 * PX_PER_MM;
	const footerH = 4.6 * PX_PER_MM;
	const fieldMaxW = 27 * PX_PER_MM;

	// Outer frame kept inside the raster so edges stay detectable after print.
	fillRect(surface, 0, 0, WIDTH, HEIGHT, navy);
	fillRect(surface, 1.15 * PX_PER_MM, 1.15 * PX_PER_MM,
		WIDTH - 2.3 * PX_PER_MM, HEIGHT - 2.3 * PX_PER_MM, [247, 249, 252]);

	fillRect(surface, 0, 0, WIDTH, headerH, navyDeep);
	fillRect(surface, 0, headerH - 0.55 * PX_PER_MM, WIDTH, 0.55 * PX_PER_MM, gold);

	// ~2.6 mm / ~1.75 mm glyph height — readable on an ID-1 print and phone preview.
	drawText(surface, 'REPUBLIC OF MALDIVES', 3.5 * PX_PER_MM, 2.0 * PX_PER_MM, 6, [255, 255, 255]);
	drawText(surface, 'NATIONAL IDENTITY CARD', 3.5 * PX_PER_MM, 6.5 * PX_PER_MM, 4, [210, 224, 245]);

	drawPortrait(surface, portrait, PORTRAIT_RECT);
	drawQr(surface, qr);

	const idX = PORTRAIT_RECT.x * PX_PER_MM;
	const idWidth = PORTRAIT_RECT.width * PX_PER_MM;
	const idText = cardholder.idNumber;
	const idScale = 4;
	drawText(surface, idText,
		idX + (idWidth - textWidth(idText, idScale)) / 2,
		(PORTRAIT_RECT.y + PORTRAIT_RECT.height + 1.0) * PX_PER_MM, idScale, navy);

	let y = 13.0 * PX_PER_MM;
	const x = 27 * PX_PER_MM;
	const labelScale = 3;
	const valueScale = 5;
	const smallScale = 4;
	const labelGap = 0.35 * PX_PER_MM;
	const blockGap = 1.1 * PX_PER_MM;

	const drawField = (fieldLabel, value, scale = valueScale) => {
		drawText(surface, fieldLabel, x, y, labelScale, label);
		y += textHeight(labelScale) + labelGap;
		y = drawWrapped(surface, value, x, y, scale, ink, fieldMaxW, Math.round(0.35 * PX_PER_MM));
		y += blockGap;
	};

	drawField('NAME', cardholder.name);

	// Sex is short; pair it with expiry. DOB stays full-width so it cannot
	// run into the QR quiet zone the way a side-by-side date used to.
	const pairGap = 9 * PX_PER_MM;
	const pairScale = 4;
	drawText(surface, 'SEX', x, y, labelScale, label);
	drawText(surface, 'EXPIRES', x + pairGap, y, labelScale, label);
	y += textHeight(labelScale) + labelGap;
	drawText(surface, cardholder.sex, x, y, pairScale, ink);
	drawText(surface, cardholder.expiry, x + pairGap, y, pairScale, ink);
	y += textHeight(pairScale) + blockGap;

	drawField('DATE OF BIRTH', cardholder.dob);
	drawField('PERMANENT ADDRESS', cardholder.address, smallScale);

	fillRect(surface, 0, HEIGHT - footerH, WIDTH, footerH, navy);
	const footerY = HEIGHT - footerH + 1.15 * PX_PER_MM;
	const footerScale = 3;
	drawText(surface, 'DEPT OF NATIONAL REGISTRATION', 3.2 * PX_PER_MM, footerY, footerScale, [230, 238, 250]);
	drawText(surface, 'BLS12-381 SIGNED',
		WIDTH - 3.2 * PX_PER_MM - textWidth('BLS12-381 SIGNED', footerScale),
		footerY, footerScale, [230, 238, 250]);

	return surface;
}

/* ------------------------------ Build ------------------------------ */

const photoHash = pHashHex(PORTRAITS.a);
const message = buildMessage(CARDHOLDER, photoHash);
const signature = await signMessage(message, DEMO_SECRET_KEY);
const barcodeData = joinBarcodeData(message, signature);
const encoded = encodeBarcode(barcodeData);

mkdirSync(OUT_DIR, { recursive: true });

const genuine = renderCard(PORTRAITS.a, encoded.qr);
writeFileSync(join(OUT_DIR, 'card-genuine.png'), encodePng(WIDTH, HEIGHT, genuine.data));

// Same signed QR, different face: the signature still verifies, the portrait
// check is what catches it.
const forged = renderCard(PORTRAITS.b, encoded.qr);
writeFileSync(join(OUT_DIR, 'card-forged.png'), encodePng(WIDTH, HEIGHT, forged.data));

// Correctly signed and correctly photographed, but out of date. Nothing
// cryptographic catches this one; only the expiry check does.
const expiredMessage = buildMessage(EXPIRED_CARDHOLDER, photoHash);
const expiredSignature = await signMessage(expiredMessage, DEMO_SECRET_KEY);
const expiredEncoded = encodeBarcode(joinBarcodeData(expiredMessage, expiredSignature));
const expired = renderCard(PORTRAITS.a, expiredEncoded.qr, EXPIRED_CARDHOLDER);
writeFileSync(join(OUT_DIR, 'card-expired.png'), encodePng(WIDTH, HEIGHT, expired.data));

// A card reprinted under a different name, with the QR re-encoded to match so
// that nothing on the face of it looks wrong. The signature is what fails.
const TAMPERED_CARDHOLDER = { ...CARDHOLDER, name: 'Mohamed Imposter Ali' };
const tamperedMessage = buildMessage(TAMPERED_CARDHOLDER, photoHash);
const tamperedEncoded = encodeBarcode(joinBarcodeData(tamperedMessage, signature));
const tampered = renderCard(PORTRAITS.a, tamperedEncoded.qr, TAMPERED_CARDHOLDER);
writeFileSync(join(OUT_DIR, 'card-tampered.png'), encodePng(WIDTH, HEIGHT, tampered.data));

console.log(`issuer            ${ISSUER.name}`);
console.log(`portrait hash     ${photoHash}`);
console.log(`forged face hash  ${pHashHex(PORTRAITS.b)}`);
console.log(`expiry            ${CARDHOLDER.expiry} (genuine), ${EXPIRED_CARDHOLDER.expiry} (expired sample)`);
console.log(`payload           ${barcodeData.length} chars -> ${encoded.byteLength} bytes, QR version ${encoded.qr.version} (${encoded.qr.size} modules)`);
console.log(`card raster       ${WIDTH}x${HEIGHT} at ${PX_PER_MM} px/mm`);
console.log('wrote samples/card-genuine.png, card-forged.png, card-expired.png and card-tampered.png');
