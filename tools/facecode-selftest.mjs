/*
 * Self-test for the MV3 face code. Run with:
 *   node tools/facecode-selftest.mjs
 *
 * The first half checks the projection itself and needs no models. The second
 * half runs the real face-api networks (CPU backend, a few seconds per face) on
 * the two sample portraits, degraded the way printing and re-photographing a
 * card degrades them, and checks that the same face stays inside the match
 * threshold while a different face stays outside it.
 */

import { loadNodeFaceApi, readRgbaDump, quietTfBanner } from './node-faceapi.mjs';
import {
	faceCodeFromDescriptor,
	faceCodeFromPixels,
	faceCodeDistance,
	isValidFaceCode,
	FACE_CODE_BITS,
	FACE_CODE_HEX,
	DESCRIPTOR_SIZE,
	FACE_MATCH_THRESHOLD,
	CALIBRATION
} from '../js/facecode.js';
import { FACE_MEAN } from '../js/facecode-params.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');

const results = [];
function check(label, ok, detail = '') {
	results.push(ok);
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label.padEnd(52)} ${detail}`);
}

function lcg(seed) {
	let state = seed >>> 0;
	return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

/* ------------------------------ Projection ------------------------------ */

console.log('Projection');

const random = lcg(7);
const descriptor = Float32Array.from({ length: DESCRIPTOR_SIZE }, (_, j) => FACE_MEAN[j] + (random() - 0.5) * 0.2);
const code = faceCodeFromDescriptor(descriptor);

check('code is 128 bits of lowercase hex', isValidFaceCode(code) && code.length === FACE_CODE_HEX, code);
check('projection is deterministic', faceCodeFromDescriptor(Float32Array.from(descriptor)) === code);
check('distance to itself is 0', faceCodeDistance(code, code) === 0);

const mirrored = Float32Array.from(descriptor, (v, j) => 2 * FACE_MEAN[j] - v);
check('opposite side of the mean flips every bit',
	faceCodeDistance(code, faceCodeFromDescriptor(mirrored)) === FACE_CODE_BITS,
	`${faceCodeDistance(code, faceCodeFromDescriptor(mirrored))} bits`);

const nudged = Float32Array.from(descriptor, v => v + (random() - 0.5) * 0.01);
const nudgedDistance = faceCodeDistance(code, faceCodeFromDescriptor(nudged));
check('small perturbation moves few bits', nudgedDistance <= 12, `${nudgedDistance} bits`);

const unrelated = Float32Array.from({ length: DESCRIPTOR_SIZE }, (_, j) => FACE_MEAN[j] + (random() - 0.5) * 0.2);
const unrelatedDistance = faceCodeDistance(code, faceCodeFromDescriptor(unrelated));
check('independent vector lands near half the bits', unrelatedDistance >= 40 && unrelatedDistance <= 88, `${unrelatedDistance} bits`);

let threw = false;
try { faceCodeFromDescriptor(new Float32Array(64)); } catch { threw = true; }
check('wrong descriptor length is refused', threw);
threw = false;
try { faceCodeDistance(code, code.slice(1)); } catch { threw = true; }
check('malformed code is refused by distance', threw);

check('threshold is inside the code', FACE_MATCH_THRESHOLD > 0 && FACE_MATCH_THRESHOLD < FACE_CODE_BITS / 2,
	`${FACE_MATCH_THRESHOLD} bits${CALIBRATION ? `, calibrated on ${CALIBRATION.dataset}` : ', uncalibrated'}`);

/* ------------------------------ Real faces ------------------------------ */

function map(pixels, fn) {
	const data = new Uint8ClampedArray(pixels.data.length);
	for (let i = 0; i < data.length; i += 4) {
		const [r, g, b] = fn(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]);
		data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
	}
	return { width: pixels.width, height: pixels.height, data };
}

const tone = (pixels, gain, offset) => map(pixels, (r, g, b) => [r * gain + offset, g * gain + offset, b * gain + offset]);

function boxBlur(pixels, radius) {
	const { width, height } = pixels;
	const data = new Uint8ClampedArray(pixels.data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let count = 0;
			for (let dy = -radius; dy <= radius; dy++) {
				for (let dx = -radius; dx <= radius; dx++) {
					const sx = Math.min(width - 1, Math.max(0, x + dx));
					const sy = Math.min(height - 1, Math.max(0, y + dy));
					sum += pixels.data[(sy * width + sx) * 4];
					count++;
				}
			}
			const i = (y * width + x) * 4;
			data[i] = data[i + 1] = data[i + 2] = sum / count;
			data[i + 3] = 255;
		}
	}
	return { width, height, data };
}

// Downsample then upsample with nearest neighbour: a cheap stand-in for a print at ~300 dpi re-shot by a phone.
function resample(pixels, factor) {
	const { width, height } = pixels;
	const data = new Uint8ClampedArray(pixels.data.length);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sx = Math.min(width - 1, Math.floor(Math.floor(x / factor) * factor));
			const sy = Math.min(height - 1, Math.floor(Math.floor(y / factor) * factor));
			data.set(pixels.data.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * width + x) * 4);
		}
	}
	return { width, height, data };
}

function shift(pixels, dx, dy) {
	const { width, height } = pixels;
	const data = new Uint8ClampedArray(pixels.data.length).fill(128);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const sx = x - dx;
			const sy = y - dy;
			const i = (y * width + x) * 4;
			if (sx >= 0 && sy >= 0 && sx < width && sy < height) data.set(pixels.data.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), i);
			data[i + 3] = 255;
		}
	}
	return { width, height, data };
}

function noise(pixels, amplitude, seed) {
	const next = lcg(seed);
	return map(pixels, (r, g, b) => {
		const n = (next() - 0.5) * 2 * amplitude;
		return [r + n, g + n, b + n];
	});
}

if (process.argv.includes('--no-models')) {
	finish();
} else {
	quietTfBanner();
	console.log('\nReal faces (face-api on the CPU backend)');
	const started = Date.now();
	await loadNodeFaceApi();

	const a = readRgbaDump(join(SAMPLES, 'portrait-a.rgba'));
	const b = readRgbaDump(join(SAMPLES, 'portrait-b.rgba'));

	const signed = await faceCodeFromPixels(a);
	check('face found in the sample portrait', Boolean(signed), signed ? `score ${signed.score.toFixed(2)}` : '');
	const again = await faceCodeFromPixels(a);
	check('same pixels give the same code', signed && again && signed.code === again.code);

	const variants = [
		['darker print (gain 0.8, -10)', tone(a, 0.8, -10)],
		['washed-out print (gain 0.7, +50)', tone(a, 0.7, 50)],
		['soft focus (3x3 blur)', boxBlur(a, 1)],
		['low resolution (2x resample)', resample(a, 2)],
		['sensor noise (±12)', noise(a, 12, 99)],
		['framing off by 8 px', shift(a, 8, -6)]
	];
	const genuine = [];
	for (const [label, pixels] of variants) {
		const face = await faceCodeFromPixels(pixels);
		const distance = face && signed ? faceCodeDistance(signed.code, face.code) : null;
		if (distance !== null) genuine.push(distance);
		check(`same face, ${label}`, distance !== null && distance <= FACE_MATCH_THRESHOLD,
			distance === null ? 'no face found' : `${distance} bits`);
	}

	const other = await faceCodeFromPixels(b);
	const impostor = other && signed ? faceCodeDistance(signed.code, other.code) : null;
	check('different person stays above the threshold', impostor !== null && impostor > FACE_MATCH_THRESHOLD,
		impostor === null ? 'no face found' : `${impostor} bits`);

	if (genuine.length && impostor !== null) {
		check('worst genuine variant is closer than the impostor', Math.max(...genuine) < impostor,
			`${Math.max(...genuine)} vs ${impostor} bits`);
	}
	console.log(`  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	finish();
}

function finish() {
	const passed = results.filter(Boolean).length;
	console.log(`\n${passed}/${results.length} passed`);
	process.exitCode = passed === results.length ? 0 : 1;
}
