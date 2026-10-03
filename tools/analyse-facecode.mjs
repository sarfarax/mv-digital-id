/*
 * Compare face code variants on the descriptor cache written by
 * tools/calibrate-facecode.mjs. Run with:
 *
 *   node tools/analyse-facecode.mjs /path/to/lfw
 *
 * Reads <lfw>-mv3-cache/descriptors.json, so calibration must have run first.
 * Prints true-accept rates at 1% and 0.1% false accept, and the equal error
 * rate, for:
 *
 * - the unbinarised descriptor (Euclidean and centred cosine): the ceiling any
 *   binary code derived from it can approach;
 * - the shipped 128-bit code, and a 256-bit variant;
 * - both with per-dimension whitening (dividing by the population standard
 *   deviation before projection).
 *
 * These are the figures quoted in SPECIFICATION.md and the README. Nothing is
 * written.
 */

import { existsSync, readFileSync } from 'node:fs';
import { FACE_MEAN } from '../js/facecode-params.js';

const PROJECTION_SEED = 0x4d5633;
const D = 128;

const lfwRoot = process.argv[2]?.replace(/\/+$/, '');
const cachePath = `${lfwRoot}-mv3-cache/descriptors.json`;
if (!lfwRoot || !existsSync(cachePath)) {
	console.error('usage: node tools/analyse-facecode.mjs /path/to/lfw  (run tools/calibrate-facecode.mjs first)');
	process.exit(1);
}

const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
const byPerson = new Map();
for (const [key, descriptor] of Object.entries(cache)) {
	if (!descriptor) continue;
	const person = key.split('/')[0];
	if (!byPerson.has(person)) byPerson.set(person, []);
	byPerson.get(person).push([key, descriptor]);
}

// Same split as the calibration: single-photo people estimate population
// statistics, people with two or more photos are evaluated on their first two.
const meanPeople = [...byPerson.values()].filter(list => list.length === 1).map(list => list[0][1]);
const evalPairs = [...byPerson.values()]
	.filter(list => list.length >= 2)
	.map(list => list.sort((a, b) => a[0].localeCompare(b[0])).slice(0, 2).map(entry => entry[1]));
console.log(`population ${meanPeople.length} faces, evaluation ${evalPairs.length} people`);

const std = new Float64Array(D);
for (const d of meanPeople) for (let j = 0; j < D; j++) std[j] += (d[j] - FACE_MEAN[j]) ** 2 / meanPeople.length;
for (let j = 0; j < D; j++) std[j] = Math.sqrt(std[j]);

function mulberry32(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (t ^ (t >>> 14)) >>> 0;
	};
}

function coder(bits, whiten) {
	const next = mulberry32(PROJECTION_SEED);
	const planes = Int8Array.from({ length: bits * D }, () => (next() & 1 ? 1 : -1));
	return d => {
		const out = new Uint8Array(bits);
		for (let i = 0; i < bits; i++) {
			let dot = 0;
			for (let j = 0; j < D; j++) dot += planes[i * D + j] * (d[j] - FACE_MEAN[j]) / (whiten ? std[j] : 1);
			out[i] = dot > 0 ? 1 : 0;
		}
		return out;
	};
}

const hamming = (a, b) => a.reduce((sum, bit, i) => sum + (bit !== b[i]), 0);
const euclidean = (a, b) => Math.sqrt(a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0));
function cosineDistance(a, b) {
	let dot = 0, na = 0, nb = 0;
	for (let j = 0; j < D; j++) {
		const x = a[j] - FACE_MEAN[j];
		const y = b[j] - FACE_MEAN[j];
		dot += x * y; na += x * x; nb += y * y;
	}
	return 1 - dot / Math.sqrt(na * nb);
}

function report(label, distance) {
	const genuine = evalPairs.map(([a, b]) => distance(a, b));
	const impostor = [];
	for (let i = 0; i < evalPairs.length; i++) {
		for (let j = i + 1; j < evalPairs.length; j++) impostor.push(distance(evalPairs[i][0], evalPairs[j][0]));
	}
	const sorted = [...impostor].sort((a, b) => a - b);
	// Accept strictly below the impostor quantile, so at most `far` of impostors pass.
	const tarAt = far => {
		const limit = sorted[Math.floor(far * sorted.length)];
		return genuine.filter(g => g < limit).length / genuine.length;
	};
	let eer = { gap: Infinity, value: 1 };
	for (const t of [...new Set([...genuine, ...impostor])].sort((a, b) => a - b)) {
		const frr = genuine.filter(g => g > t).length / genuine.length;
		const far = impostor.filter(x => x <= t).length / impostor.length;
		if (Math.abs(frr - far) < eer.gap) eer = { gap: Math.abs(frr - far), value: (frr + far) / 2 };
	}
	const pct = v => `${(v * 100).toFixed(1)}%`.padStart(6);
	console.log(`${label.padEnd(30)} TAR@1% ${pct(tarAt(0.01))}   TAR@0.1% ${pct(tarAt(0.001))}   EER ${pct(eer.value)}`);
}

report('descriptor, euclidean', euclidean);
report('descriptor, centred cosine', cosineDistance);
for (const bits of [128, 256]) {
	const plain = coder(bits, false);
	report(`${bits}-bit code`, (a, b) => hamming(plain(a), plain(b)));
	const whitened = coder(bits, true);
	report(`${bits}-bit code, whitened`, (a, b) => hamming(whitened(a), whitened(b)));
}
