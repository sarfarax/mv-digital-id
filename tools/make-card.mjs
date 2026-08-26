/*
 * Render ready-made sample cards. Run with: node tools/make-card.mjs
 *
 * Produces a genuine card and a forgery of it, so the scanner can be tried
 * without a camera or a printer: drop samples/card-genuine.png on the verify
 * page and it should pass, drop samples/card-forged.png and the signature
 * still passes while the portrait check fails.
 *
 * The card is rasterised directly rather than screenshotting the DOM, which
 * keeps this runnable from the command line. Only two things have to be exact:
 * the portrait and the QR must land precisely on the millimetre rectangles in
 * js/card.js, because that is what the scanner's homography assumes.
 */

import './browser-shim.mjs';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
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

const CARDHOLDER = {
	idNumber: 'A123456',
	name: 'Aishath Nasheeda Ibrahim',
	sex: 'F',
	dob: '1991-04-17',
	phone: '+960 771 2345',
	address: 'Ma. Blue Heaven, Male, Maldives'
};

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

/* ------------------------------ Portraits ------------------------------ */

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/*
 * The canonical 300x400 grayscale portrait, generated directly at its final
 * size. This is the exact raster that gets hashed and printed, so the browser
 * has nothing to reproduce and no resampling mismatch can creep in.
 */
function canonicalPortrait({ seed, skinBase, backdrop, faceCx, faceCy, faceRx, faceRy, hairTone, eyeSkew, lightFrom }) {
	const width = 300;
	const height = 400;
	const rnd = mulberry32(seed);
	const grain = new Float64Array(width * height);
	for (let i = 0; i < grain.length; i++) grain[i] = rnd();

	const imageData = { data: new Uint8ClampedArray(width * height * 4), width, height };

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const nx = x / width;
			const ny = y / height;
			let value = backdrop * (1 - 0.28 * ny) + 14;

			const cx = width * faceCx;
			const cy = height * faceCy;
			const rx = width * faceRx;
			const ry = height * faceRy;

			if (y > height * 0.78 - 45 * Math.cos(((x - cx) / width) * 3.1)) value = 58;

			const hx = (x - cx - width * 0.02) / (rx * 1.24);
			const hy = (y - cy + ry * 0.34) / (ry * 1.18);
			if (hx * hx + hy * hy < 1 && y < cy + ry * 0.45) value = hairTone;

			const fx = (x - cx) / rx;
			const fy = (y - cy) / ry;
			const face = fx * fx + fy * fy;
			if (face < 1) {
				value = skinBase * (1 - 0.3 * face);
				const eyeY = cy - ry * 0.16;
				if (Math.hypot(x - (cx - rx * 0.36), y - eyeY) < rx * 0.13) value = 38;
				if (Math.hypot(x - (cx + rx * 0.36 + eyeSkew), y - eyeY - eyeSkew * 0.4) < rx * 0.12) value = 38;
				if (Math.abs(y - (eyeY - ry * 0.15)) < ry * 0.035 && Math.abs(x - cx) < rx * 0.62) value *= 0.45;
				if (Math.abs(x - (cx + rx * 0.05)) < rx * 0.07 && y > cy - ry * 0.05 && y < cy + ry * 0.2) value *= 0.86;
				if (Math.hypot((x - cx) / (rx * 0.34), (y - (cy + ry * 0.42)) / (ry * 0.09)) < 1) value = 104;
			}

			const light = 1 + 0.3 * (lightFrom === 'left' ? 1 - nx : nx) - 0.12 * ny;
			const shade = Math.max(0, Math.min(255, value * light + (grain[y * width + x] - 0.5) * 9));

			const p = (y * width + x) * 4;
			imageData.data[p] = shade;
			imageData.data[p + 1] = shade;
			imageData.data[p + 2] = shade;
			imageData.data[p + 3] = 255;
		}
	}

	return imageData;
}

const PORTRAITS = {
	a: canonicalPortrait({
		seed: 17, skinBase: 186, backdrop: 190,
		faceCx: 0.52, faceCy: 0.42, faceRx: 0.27, faceRy: 0.24,
		hairTone: 38, eyeSkew: 5, lightFrom: 'left'
	}),
	b: canonicalPortrait({
		seed: 91, skinBase: 128, backdrop: 204,
		faceCx: 0.47, faceCy: 0.46, faceRx: 0.24, faceRy: 0.28,
		hairTone: 22, eyeSkew: -4, lightFrom: 'right'
	})
};

// Bilinear upscale of a portrait into the card's portrait rectangle.
function drawPortrait(surface, portrait, rect) {
	const x0 = Math.round(rect.x * PX_PER_MM);
	const y0 = Math.round(rect.y * PX_PER_MM);
	const w = Math.round(rect.width * PX_PER_MM);
	const h = Math.round(rect.height * PX_PER_MM);

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

function renderCard(portrait, qr) {
	const surface = createSurface(WIDTH, HEIGHT);
	const teal = [10, 84, 76];
	const ink = [20, 32, 43];
	const grey = [109, 120, 131];

	fillRect(surface, 0, 0, WIDTH, 10.5 * PX_PER_MM, teal);
	drawText(surface, 'REPUBLIC OF MALDIVES', 3.5 * PX_PER_MM, 2.4 * PX_PER_MM, 3, [255, 255, 255]);
	drawText(surface, 'NATIONAL IDENTITY CARD', 3.5 * PX_PER_MM, 6.6 * PX_PER_MM, 2, [200, 226, 222]);

	drawPortrait(surface, portrait, PORTRAIT_RECT);
	drawQr(surface, qr);

	const idX = PORTRAIT_RECT.x * PX_PER_MM;
	const idWidth = PORTRAIT_RECT.width * PX_PER_MM;
	const idText = CARDHOLDER.idNumber;
	drawText(surface, idText,
		idX + (idWidth - textWidth(idText, 3)) / 2,
		(PORTRAIT_RECT.y + PORTRAIT_RECT.height + 1.4) * PX_PER_MM, 3, ink);

	let y = 14 * PX_PER_MM;
	const x = 27 * PX_PER_MM;
	const rows = [
		['NAME', CARDHOLDER.name],
		['SEX', CARDHOLDER.sex],
		['DATE OF BIRTH', CARDHOLDER.dob],
		['PHONE', CARDHOLDER.phone],
		['PERMANENT ADDRESS', CARDHOLDER.address]
	];
	for (const [label, value] of rows) {
		drawText(surface, label, x, y, 1, grey);
		drawText(surface, value, x, y + 1.1 * PX_PER_MM, 2, ink);
		y += 5.2 * PX_PER_MM;
	}

	drawText(surface, 'BLS12-381 SIGNED', 3.5 * PX_PER_MM, HEIGHT - 3 * PX_PER_MM, 1, grey);

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

console.log(`issuer            ${ISSUER.name}`);
console.log(`portrait hash     ${photoHash}`);
console.log(`forged face hash  ${pHashHex(PORTRAITS.b)}`);
console.log(`payload           ${barcodeData.length} chars -> ${encoded.byteLength} bytes, QR version ${encoded.qr.version} (${encoded.qr.size} modules)`);
console.log(`card raster       ${WIDTH}x${HEIGHT} at ${PX_PER_MM} px/mm`);
console.log('wrote samples/card-genuine.png and samples/card-forged.png');
