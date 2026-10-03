/*
 * Calibrate the MV3 face code. Run with:
 *
 *   node tools/calibrate-facecode.mjs /path/to/lfw
 *
 * where the argument is an extracted copy of Labeled Faces in the Wild (one
 * folder per person). Writes js/facecode-params.js.
 *
 * Two disjoint groups of people are drawn deterministically:
 *
 * - people with a single photograph estimate the population mean descriptor
 *   that every face is centred on before projection;
 * - people with two or more photographs are held out to measure the code:
 *   genuine pairs (two photos of one person) against impostor pairs (first
 *   photos of two different people).
 *
 * The threshold is the largest Hamming distance at which no more than 0.1% of
 * impostor pairs are accepted. LFW pairs differ in age, pose and lighting far
 * more than an ID photograph and a cooperative live capture do, so the
 * acceptance rate measured here is a conservative floor.
 *
 * Only aggregate statistics are written; no image or descriptor of any LFW
 * subject is committed. JPEG decoding goes through macOS `sips` or ImageMagick,
 * since the project has no dependencies. Descriptors are cached next to the
 * dataset, so a rerun takes seconds.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadNodeFaceApi, readBmp, quietTfBanner } from './node-faceapi.mjs';
import { describeFace, DESCRIPTOR_SIZE, FACE_CODE_BITS } from '../js/facecode.js';

const MEAN_PEOPLE = 500;
const EVAL_PEOPLE = 300;
// The default threshold admits at most 0.1% of impostor pairs. The 1% point is
// reported too, for checkpoints that would rather reject fewer genuine holders.
const TARGET_FAR = 0.001;
const LOOSE_FAR = 0.01;
const PROJECTION_SEED = 0x4d5633;

const lfwRoot = process.argv[2];
if (!lfwRoot || !existsSync(lfwRoot)) {
	console.error('usage: node tools/calibrate-facecode.mjs /path/to/lfw');
	process.exit(1);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'facecode-params.js');
const workDir = join(dirname(lfwRoot), `${basename(lfwRoot)}-mv3-cache`);
const bmpDir = join(workDir, 'bmp');
const cachePath = join(workDir, 'descriptors.json');
mkdirSync(bmpDir, { recursive: true });

/* ------------------------------ Selection ------------------------------ */

const people = readdirSync(lfwRoot, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => ({
		name: entry.name,
		images: readdirSync(join(lfwRoot, entry.name)).filter(file => file.toLowerCase().endsWith('.jpg')).sort()
	}))
	.sort((a, b) => a.name.localeCompare(b.name));

function evenlySpaced(list, count) {
	if (list.length <= count) return list;
	const step = list.length / count;
	return Array.from({ length: count }, (_, i) => list[Math.floor(i * step)]);
}

const meanSet = evenlySpaced(people.filter(p => p.images.length === 1), MEAN_PEOPLE);
const evalSet = evenlySpaced(people.filter(p => p.images.length >= 2), EVAL_PEOPLE);

const jobs = [
	...meanSet.map(p => join(p.name, p.images[0])),
	...evalSet.flatMap(p => [join(p.name, p.images[0]), join(p.name, p.images[1])])
];

/* ------------------------------ Decoding ------------------------------ */

function hasTool(tool) {
	try {
		execFileSync('which', [tool], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const converter = hasTool('sips') ? 'sips' : hasTool('magick') ? 'magick' : null;
if (!converter) {
	console.error('Needs macOS `sips` or ImageMagick `magick` to decode JPEG.');
	process.exit(1);
}

const bmpPath = job => join(bmpDir, job.replace(/[\\/]/g, '__').replace(/\.jpg$/i, '.bmp'));

const pending = jobs.filter(job => !existsSync(bmpPath(job)));
for (let i = 0; i < pending.length; i += 100) {
	const batch = pending.slice(i, i + 100);
	if (converter === 'sips') {
		for (const job of batch) {
			execFileSync('sips', ['-s', 'format', 'bmp', join(lfwRoot, job), '--out', bmpPath(job)], { stdio: 'ignore' });
		}
	} else {
		for (const job of batch) execFileSync('magick', [join(lfwRoot, job), `BMP3:${bmpPath(job)}`], { stdio: 'ignore' });
	}
	process.stdout.write(`\rdecoded ${Math.min(i + 100, pending.length)}/${pending.length}`);
}
if (pending.length) process.stdout.write('\n');

/* ------------------------------ Description ------------------------------ */

quietTfBanner();
await loadNodeFaceApi();

const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
let fresh = 0;
const started = Date.now();
for (const [index, job] of jobs.entries()) {
	if (job in cache) continue;
	const face = await describeFace(readBmp(bmpPath(job)));
	cache[job] = face ? Array.from(face.descriptor, v => Number(v.toFixed(6))) : null;
	fresh++;
	if (fresh % 25 === 0) {
		writeFileSync(cachePath, JSON.stringify(cache));
		const rate = (Date.now() - started) / fresh;
		const left = jobs.slice(index).filter(j => !(j in cache)).length;
		process.stdout.write(`\rdescribed ${index + 1}/${jobs.length}, about ${Math.round((left * rate) / 60000)} min left   `);
	}
}
writeFileSync(cachePath, JSON.stringify(cache));
if (fresh) process.stdout.write('\n');

/* ------------------------------ Statistics ------------------------------ */

const meanDescriptors = meanSet.map(p => cache[join(p.name, p.images[0])]).filter(Boolean);
const mean = new Float64Array(DESCRIPTOR_SIZE);
for (const d of meanDescriptors) for (let j = 0; j < DESCRIPTOR_SIZE; j++) mean[j] += d[j] / meanDescriptors.length;

// Same projection as js/facecode.js, parameterised on the mean so the
// uncentred baseline can be reported alongside.
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
const next = mulberry32(PROJECTION_SEED);
const planes = Int8Array.from({ length: FACE_CODE_BITS * DESCRIPTOR_SIZE }, () => (next() & 1 ? 1 : -1));
const bitsOf = (d, centre) => {
	const bits = new Uint8Array(FACE_CODE_BITS);
	for (let i = 0; i < FACE_CODE_BITS; i++) {
		let dot = 0;
		for (let j = 0; j < DESCRIPTOR_SIZE; j++) dot += planes[i * DESCRIPTOR_SIZE + j] * (d[j] - centre[j]);
		bits[i] = dot > 0 ? 1 : 0;
	}
	return bits;
};
const hamming = (a, b) => a.reduce((sum, bit, i) => sum + (bit !== b[i]), 0);

function evaluate(centre) {
	const pairs = evalSet
		.map(p => [cache[join(p.name, p.images[0])], cache[join(p.name, p.images[1])]])
		.filter(([a, b]) => a && b)
		.map(([a, b]) => [bitsOf(a, centre), bitsOf(b, centre)]);
	const genuine = pairs.map(([a, b]) => hamming(a, b));
	const impostor = [];
	for (let i = 0; i < pairs.length; i++) {
		for (let j = i + 1; j < pairs.length; j++) impostor.push(hamming(pairs[i][0], pairs[j][0]));
	}
	return { genuine, impostor };
}

const rate = (list, accept) => list.filter(accept).length / list.length;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

function thresholdFor(impostor, far) {
	let threshold = 0;
	for (let t = 0; t <= FACE_CODE_BITS; t++) {
		if (rate(impostor, d => d <= t) <= far) threshold = t;
	}
	return threshold;
}

function summarise({ genuine, impostor }) {
	const threshold = thresholdFor(impostor, TARGET_FAR);
	const looseThreshold = thresholdFor(impostor, LOOSE_FAR);
	let eer = { t: 0, gap: Infinity, value: 1 };
	for (let t = 0; t <= FACE_CODE_BITS; t++) {
		const frr = rate(genuine, d => d > t);
		const far = rate(impostor, d => d <= t);
		if (Math.abs(frr - far) < eer.gap) eer = { t, gap: Math.abs(frr - far), value: (frr + far) / 2 };
	}
	return {
		threshold,
		tar: rate(genuine, d => d <= threshold),
		far: rate(impostor, d => d <= threshold),
		looseThreshold,
		looseTar: rate(genuine, d => d <= looseThreshold),
		looseFar: rate(impostor, d => d <= looseThreshold),
		eer: eer.value,
		genuineMedian: median(genuine),
		impostorMedian: median(impostor),
		impostorMin: Math.min(...impostor),
		genuinePairs: genuine.length,
		impostorPairs: impostor.length
	};
}

const centred = summarise(evaluate(mean));
const raw = summarise(evaluate(new Float64Array(DESCRIPTOR_SIZE)));

const pct = v => `${(v * 100).toFixed(1)}%`;
console.log(`mean estimated from ${meanDescriptors.length} faces (${meanSet.length - meanDescriptors.length} undetected)`);
for (const [label, s] of [['uncentred', raw], ['centred', centred]]) {
	console.log(`${label.padEnd(10)} threshold ${s.threshold}  TAR ${pct(s.tar)}  FAR ${pct(s.far)}  |  ` +
		`threshold ${s.looseThreshold}  TAR ${pct(s.looseTar)}  FAR ${pct(s.looseFar)}  |  EER ${pct(s.eer)}  ` +
		`median genuine ${s.genuineMedian} / impostor ${s.impostorMedian}`);
}

/* ------------------------------ Output ------------------------------ */

const calibration = {
	dataset: 'Labeled Faces in the Wild',
	meanFaces: meanDescriptors.length,
	genuinePairs: centred.genuinePairs,
	impostorPairs: centred.impostorPairs,
	targetFar: TARGET_FAR,
	threshold: centred.threshold,
	tar: Number(centred.tar.toFixed(4)),
	far: Number(centred.far.toFixed(5)),
	looseThreshold: centred.looseThreshold,
	looseTar: Number(centred.looseTar.toFixed(4)),
	looseFar: Number(centred.looseFar.toFixed(5)),
	eer: Number(centred.eer.toFixed(4)),
	genuineMedian: centred.genuineMedian,
	impostorMedian: centred.impostorMedian
};

const meanLines = [];
for (let j = 0; j < DESCRIPTOR_SIZE; j += 8) {
	meanLines.push('\t' + Array.from(mean.slice(j, j + 8), v => v.toFixed(6)).join(', '));
}

writeFileSync(OUT, `// Generated by tools/calibrate-facecode.mjs. Do not edit by hand.
//
// Population mean of face-api descriptors, estimated from ${calibration.meanFaces} faces in
// ${calibration.dataset}. A national deployment would recompute this from its own
// enrolment photographs; changing it changes every face code, so it is pinned
// to the schema version.

export const FACE_MEAN = Float64Array.from([
${meanLines.join(',\n')}
]);

// Largest distance with at most ${TARGET_FAR * 100}% of impostor pairs accepted.
export const FACE_MATCH_THRESHOLD = ${centred.threshold};

export const CALIBRATION = Object.freeze(${JSON.stringify(calibration, null, '\t').replace(/\n/g, '\n')});
`);
console.log(`wrote ${OUT}`);
