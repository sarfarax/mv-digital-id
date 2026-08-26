/*
 * Generate synthetic sample portraits. Run with: node tools/make-samples.mjs
 *
 * These are test fixtures, not photographs: two clearly different synthetic
 * "people" plus a lightly degraded recapture of the first, so the verification
 * flow can be exercised end to end without shipping anyone's face. Written with
 * a minimal PNG encoder so the repo stays dependency-free.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const WIDTH = 600;
const HEIGHT = 800;

/* ----------------------------- PNG encoding ----------------------------- */

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
		const rowStart = y * (width * 3 + 1);
		raw[rowStart] = 0; // filter type: none
		rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 2;  // colour type: truecolour
	ihdr[10] = 0; // deflate
	ihdr[11] = 0; // adaptive filtering
	ihdr[12] = 0; // no interlace

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/* ----------------------------- Image synthesis ----------------------------- */

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function render(fn) {
	const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
	for (let y = 0; y < HEIGHT; y++) {
		for (let x = 0; x < WIDTH; x++) {
			const [r, g, b] = fn(x, y);
			const p = (y * WIDTH + x) * 3;
			rgb[p] = Math.max(0, Math.min(255, Math.round(r)));
			rgb[p + 1] = Math.max(0, Math.min(255, Math.round(g)));
			rgb[p + 2] = Math.max(0, Math.min(255, Math.round(b)));
		}
	}
	return rgb;
}

function smoothstep(edge0, edge1, x) {
	const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
	return t * t * (3 - 2 * t);
}

/*
 * A crude but distinctly asymmetric portrait. Asymmetry matters: a perfectly
 * mirror-symmetric image sends half the DCT coefficients to zero, they tie at
 * the median, and the resulting hash flips bits under the slightest change.
 */
function makePerson({ seed, skin, backdrop, faceCx, faceCy, faceRx, faceRy, hair, eyeOffset, lightFrom }) {
	const rnd = mulberry32(seed);
	const grain = new Float64Array(WIDTH * HEIGHT);
	for (let i = 0; i < grain.length; i++) grain[i] = rnd();

	return (x, y) => {
		const nx = x / WIDTH;
		const ny = y / HEIGHT;

		// Studio backdrop with a soft vertical falloff.
		let [r, g, b] = backdrop.map(c => c * (1 - 0.28 * ny) + 14);

		const cx = WIDTH * faceCx;
		const cy = HEIGHT * faceCy;
		const rx = WIDTH * faceRx;
		const ry = HEIGHT * faceRy;

		// Shoulders.
		const shoulderTop = HEIGHT * 0.78;
		if (y > shoulderTop - 90 * Math.cos(((x - cx) / WIDTH) * 3.1)) {
			r = 46; g = 58; b = 74;
		}

		// Hair mass, offset so the silhouette is not mirror-symmetric.
		const hx = (x - cx - WIDTH * 0.02) / (rx * 1.24);
		const hy = (y - cy + ry * 0.34) / (ry * 1.18);
		if (hx * hx + hy * hy < 1 && y < cy + ry * 0.45) {
			r = hair[0]; g = hair[1]; b = hair[2];
		}

		// Face.
		const fx = (x - cx) / rx;
		const fy = (y - cy) / ry;
		const face = fx * fx + fy * fy;
		if (face < 1) {
			const shade = 1 - 0.3 * face;
			r = skin[0] * shade; g = skin[1] * shade; b = skin[2] * shade;

			const eyeY = cy - ry * 0.16;
			const leftEye = Math.hypot(x - (cx - rx * 0.36), y - eyeY);
			const rightEye = Math.hypot(x - (cx + rx * 0.36 + eyeOffset), y - eyeY - eyeOffset * 0.4);
			if (leftEye < rx * 0.13 || rightEye < rx * 0.12) { r = 42; g = 36; b = 34; }

			// Brows, nose shadow, mouth.
			if (Math.abs(y - (eyeY - ry * 0.15)) < ry * 0.035 && Math.abs(x - cx) < rx * 0.62) {
				r *= 0.45; g *= 0.42; b *= 0.42;
			}
			if (Math.abs(x - (cx + rx * 0.05)) < rx * 0.07 && y > cy - ry * 0.05 && y < cy + ry * 0.2) {
				r *= 0.86; g *= 0.84; b *= 0.84;
			}
			const mouth = Math.hypot((x - cx) / (rx * 0.34), (y - (cy + ry * 0.42)) / (ry * 0.09));
			if (mouth < 1) { r = 148; g = 84; b = 82; }
		}

		// Directional key light plus film grain.
		const light = 1 + 0.3 * smoothstep(0, 1, lightFrom === 'left' ? 1 - nx : nx) - 0.12 * ny;
		const noise = (grain[y * WIDTH + x] - 0.5) * 9;

		return [r * light + noise, g * light + noise, b * light + noise];
	};
}

const people = {
	'portrait-a.png': makePerson({
		seed: 17,
		skin: [206, 166, 132],
		backdrop: [176, 190, 202],
		faceCx: 0.52, faceCy: 0.42, faceRx: 0.27, faceRy: 0.24,
		hair: [46, 34, 30],
		eyeOffset: 9,
		lightFrom: 'left'
	}),
	'portrait-b.png': makePerson({
		seed: 91,
		skin: [158, 116, 88],
		backdrop: [206, 200, 186],
		faceCx: 0.47, faceCy: 0.46, faceRx: 0.24, faceRy: 0.28,
		hair: [22, 20, 24],
		eyeOffset: -7,
		lightFrom: 'right'
	})
};

mkdirSync(OUT_DIR, { recursive: true });

for (const [filename, fn] of Object.entries(people)) {
	const png = encodePng(WIDTH, HEIGHT, render(fn));
	writeFileSync(join(OUT_DIR, filename), png);
	console.log(`${filename.padEnd(24)} ${WIDTH}x${HEIGHT}  ${(png.length / 1024).toFixed(1)} KB`);
}

/*
 * Person A as a camera would see her off a printed card: warmer white balance,
 * lower contrast, a slight shift and extra noise. Verification should still
 * match this against the hash issued from portrait-a.png.
 */
const base = people['portrait-a.png'];
const recaptureNoise = mulberry32(404);
const recapture = render((x, y) => {
	const [r, g, b] = base(Math.min(WIDTH - 1, x + 3), Math.max(0, y - 2));
	const n = (recaptureNoise() - 0.5) * 16;
	return [r * 0.86 + 26 + n, g * 0.86 + 22 + n, b * 0.84 + 18 + n];
});
const recapturePng = encodePng(WIDTH, HEIGHT, recapture);
writeFileSync(join(OUT_DIR, 'portrait-a-recaptured.png'), recapturePng);
console.log(`${'portrait-a-recaptured.png'.padEnd(24)} ${WIDTH}x${HEIGHT}  ${(recapturePng.length / 1024).toFixed(1)} KB`);
