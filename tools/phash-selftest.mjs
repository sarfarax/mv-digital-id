/*
 * Self-test for js/phash.js. Run with: node tools/phash-selftest.mjs
 *
 * This is a development aid only; the browser app never loads it. It builds
 * synthetic portraits, degrades them the way a camera would, and asserts that
 * the hash stays close for the same subject and far apart for a different one.
 */

import { pHash, hammingDistance, similarity, isValidHash, HASH_BITS } from '../js/phash.js';

const W = 300;
const H = 400;
const MATCH_THRESHOLD = 12;

function mulberry32(seed) {
	return function () {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function makeImage(fn, width = W, height = H) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const v = fn(x, y);
			const p = (y * width + x) * 4;
			data[p] = v;
			data[p + 1] = v;
			data[p + 2] = v;
			data[p + 3] = 255;
		}
	}
	return { data, width, height };
}

const grain = [];
const grainRnd = mulberry32(3);
for (let i = 0; i < W * H; i++) grain.push(grainRnd());

/*
 * An off-centre, directionally lit, asymmetric face. Symmetry matters: a
 * perfectly mirror-symmetric image drives half the DCT coefficients to zero,
 * they all tie at the median, and the hash becomes unstable. Real photographs
 * are never symmetric, so the test subject must not be either.
 */
function face(x, y) {
	const dx = (x - W * 0.54) / (W * 0.33);
	const dy = (y - H * 0.43) / (H * 0.33);
	let v = dx * dx + dy * dy < 1 ? 190 : 45;
	if (Math.hypot(x - W * 0.42, y - H * 0.36) < 15) v = 35;
	if (Math.hypot(x - W * 0.66, y - H * 0.39) < 13) v = 40;
	if (Math.abs(y - H * 0.58) < 5 && x > W * 0.44 && x < W * 0.68) v = 70;
	v += (x / W) * 45 - (y / H) * 25;
	v += 10 * grain[y * W + x];
	return v;
}

function otherPerson(x, y) {
	const dx = (x - W * 0.55) / (W * 0.3);
	const dy = (y - H * 0.5) / (H * 0.4);
	let v = Math.abs(dx) + Math.abs(dy) < 1 ? 70 : 210;
	if (Math.hypot(x - W * 0.45, y - H * 0.3) < 40) v = 230;
	return v + (x / W) * 20;
}

const results = [];
function check(label, actual, predicate, detail) {
	const ok = predicate(actual);
	results.push(ok);
	const status = ok ? 'PASS' : 'FAIL';
	console.log(`  [${status}] ${label.padEnd(44)} ${detail ?? actual}`);
}

const original = makeImage(face);
const reference = pHash(original).hex;

console.log(`pHash self-test (${HASH_BITS}-bit, match threshold ${MATCH_THRESHOLD})\n`);
console.log(`reference hash: ${reference}\n`);

check('hash format is 16 hex chars', reference, isValidHash);
check('hash of identical input is stable', hammingDistance(reference, pHash(makeImage(face)).hex), d => d === 0);

console.log('\nsame subject, camera-style degradation (expect small distances):');

const noise = mulberry32(11);
const degradations = {
	'brightness and contrast shift': (x, y) => face(x, y) * 0.88 + 22,
	'1 pixel translation': (x, y) => face(Math.min(W - 1, x + 1), Math.max(0, y - 1)),
	'3 pixel translation': (x, y) => face(Math.min(W - 1, x + 3), Math.max(0, y - 3)),
	'additive sensor noise': (x, y) => face(x, y) + (noise() - 0.5) * 18,
	'heavy vignette': (x, y) => {
		const r = Math.hypot((x - W / 2) / W, (y - H / 2) / H);
		return face(x, y) * (1 - 0.35 * r);
	},
	'combined recapture': (x, y) => {
		const v = face(Math.min(W - 1, x + 2), Math.max(0, y - 2)) * 0.85 + 25;
		return v + (noise() - 0.5) * 16;
	}
};

for (const [label, fn] of Object.entries(degradations)) {
	const hash = pHash(makeImage(fn)).hex;
	const distance = hammingDistance(reference, hash);
	check(label, distance, d => d <= MATCH_THRESHOLD, `distance ${distance} (similarity ${similarity(reference, hash).toFixed(2)})`);
}

console.log('\ndifferent subject (expect a large distance):');
const impostor = pHash(makeImage(otherPerson)).hex;
const impostorDistance = hammingDistance(reference, impostor);
check('different person is rejected', impostorDistance, d => d > MATCH_THRESHOLD, `distance ${impostorDistance}`);

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
