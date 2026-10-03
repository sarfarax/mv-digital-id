'use strict';

/*
 * The MV3 face code: a 128-bit locality-sensitive hash of a face embedding.
 *
 * A cryptographic hash of an embedding is useless here — two captures of the
 * same face never produce bit-identical floats, so SHA-256 of them would never
 * match. Instead the 128-dimensional face-api descriptor is centred on a
 * population mean and projected onto 128 fixed hyperplanes; each bit records
 * which side of a hyperplane the face falls on. The fraction of differing bits
 * then tracks the angle between two embeddings, so the same comparison used for
 * the photo hash — a Hamming distance against a threshold — works again.
 *
 * Centring is what makes the code discriminate. Raw descriptors share a large
 * common component, so every face sits in a narrow cone and different people
 * differ by only a handful of bits. The mean comes from tools/calibrate-facecode.mjs
 * and lives in facecode-params.js; a national deployment would recompute it on
 * its own enrolment photographs.
 *
 * The hyperplanes are ±1 vectors from a fixed integer PRNG, not Gaussian draws,
 * so every JavaScript engine reproduces them bit for bit.
 *
 * Face detection and the embedding come from face-api (TensorFlow.js), about
 * 7 MB of weights in models/. They are loaded on first use only, so verifying a
 * standard MV2 card never downloads them.
 */

import { FACE_MEAN, FACE_MATCH_THRESHOLD, CALIBRATION } from './facecode-params.js';

export const FACE_CODE_BITS = 128;
export const FACE_CODE_HEX = FACE_CODE_BITS / 4;
export const DESCRIPTOR_SIZE = 128;
export { FACE_MATCH_THRESHOLD, CALIBRATION };

// Changing either of these changes every code ever issued; bump the schema.
const PROJECTION_SEED = 0x4d5633;

/*
 * The tiny detector misses faces that fill the frame, which is exactly what an
 * ID portrait is. Padding the image with neutral grey gives it context, and a
 * short ladder of input sizes covers the rest.
 */
const PAD_FRACTION = 0.25;
const DETECTOR_INPUT_SIZES = [416, 320, 512, 224, 608];
const DETECTOR_SCORE_THRESHOLD = 0.2;

/* ------------------------------------------------------------------ *
 * Projection
 * ------------------------------------------------------------------ */

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

let projection = null;

function hyperplanes() {
	if (projection) return projection;
	const next = mulberry32(PROJECTION_SEED);
	projection = new Int8Array(FACE_CODE_BITS * DESCRIPTOR_SIZE);
	for (let i = 0; i < projection.length; i++) projection[i] = next() & 1 ? 1 : -1;
	return projection;
}

export function isValidFaceCode(hex) {
	return typeof hex === 'string' && new RegExp(`^[0-9a-f]{${FACE_CODE_HEX}}$`).test(hex);
}

/** Project a 128-float descriptor to the 32-hex-character face code. */
export function faceCodeFromDescriptor(descriptor) {
	if (!descriptor || descriptor.length !== DESCRIPTOR_SIZE) {
		throw new Error(`face descriptor must have ${DESCRIPTOR_SIZE} values`);
	}
	const planes = hyperplanes();
	const centred = new Float64Array(DESCRIPTOR_SIZE);
	for (let j = 0; j < DESCRIPTOR_SIZE; j++) centred[j] = descriptor[j] - FACE_MEAN[j];

	let hex = '';
	for (let nibble = 0; nibble < FACE_CODE_HEX; nibble++) {
		let value = 0;
		for (let k = 0; k < 4; k++) {
			const row = (nibble * 4 + k) * DESCRIPTOR_SIZE;
			let dot = 0;
			for (let j = 0; j < DESCRIPTOR_SIZE; j++) dot += planes[row + j] * centred[j];
			value = (value << 1) | (dot > 0 ? 1 : 0);
		}
		hex += value.toString(16);
	}
	return hex;
}

const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/** Number of differing bits between two face codes, 0..128. */
export function faceCodeDistance(a, b) {
	if (!isValidFaceCode(a) || !isValidFaceCode(b)) {
		throw new Error(`faceCodeDistance expects two ${FACE_CODE_HEX}-character hex codes`);
	}
	let count = 0;
	for (let i = 0; i < FACE_CODE_HEX; i++) {
		count += POPCOUNT[Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16)];
	}
	return count;
}

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

let faceApiPromise = null;

/**
 * Supply an already-initialised face-api instance. The Node tools use this
 * after loading weights from disk; the browser path goes through
 * loadFaceModels() instead.
 */
export function installFaceApi(faceapi) {
	faceApiPromise = Promise.resolve(faceapi);
}

export function faceModelsLoaded() {
	return faceApiPromise !== null;
}

/** Load face-api and its three networks once. Safe to call repeatedly. */
export function loadFaceModels() {
	if (!faceApiPromise) {
		faceApiPromise = (async () => {
			const faceapi = await import('./lib/face-api.esm.js');
			try {
				await faceapi.tf.setBackend('webgl');
			} catch {
				await faceapi.tf.setBackend('cpu');
			}
			await faceapi.tf.ready();
			const base = new URL('../models', import.meta.url).href;
			await Promise.all([
				faceapi.nets.tinyFaceDetector.loadFromUri(base),
				faceapi.nets.faceLandmark68Net.loadFromUri(base),
				faceapi.nets.faceRecognitionNet.loadFromUri(base)
			]);
			return faceapi;
		})().catch(error => {
			faceApiPromise = null;
			throw error;
		});
	}
	return faceApiPromise;
}

/* ------------------------------------------------------------------ *
 * Description
 * ------------------------------------------------------------------ */

/*
 * The printed portrait is greyscale, so the issuer embeds a greyscale face.
 * Live captures are reduced the same way before they are embedded, which keeps
 * colour out of the comparison entirely.
 */
function greyRgbTensor(tf, pixels) {
	const { width, height, data } = pixels;
	const grey = new Int32Array(width * height * 3);
	for (let i = 0, p = 0; i < width * height; i++, p += 4) {
		const y = Math.round(0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]);
		grey[i * 3] = grey[i * 3 + 1] = grey[i * 3 + 2] = y;
	}
	return tf.tensor3d(grey, [height, width, 3], 'int32');
}

/**
 * Find the most prominent face in an RGBA image and embed it.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} pixels ImageData or equivalent
 * @returns {Promise<{descriptor: Float32Array, score: number, box: {x: number, y: number, width: number, height: number}} | null>}
 */
export async function describeFace(pixels) {
	const faceapi = await loadFaceModels();
	const { tf } = faceapi;

	const padX = Math.round(pixels.width * PAD_FRACTION);
	const padY = Math.round(pixels.height * PAD_FRACTION);
	const raw = greyRgbTensor(tf, pixels);
	const padded = tf.pad(raw, [[padY, padY], [padX, padX], [0, 0]], 128);
	raw.dispose();

	try {
		for (const inputSize of DETECTOR_INPUT_SIZES) {
			const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: DETECTOR_SCORE_THRESHOLD });
			const result = await faceapi.detectSingleFace(padded, options).withFaceLandmarks().withFaceDescriptor();
			if (result) {
				const box = result.detection.box;
				return {
					descriptor: result.descriptor,
					score: result.detection.score,
					box: { x: box.x - padX, y: box.y - padY, width: box.width, height: box.height }
				};
			}
		}
		return null;
	} finally {
		padded.dispose();
	}
}

/** Describe a face and return its code, or null when no face is found. */
export async function faceCodeFromPixels(pixels) {
	const face = await describeFace(pixels);
	if (!face) return null;
	return { ...face, code: faceCodeFromDescriptor(face.descriptor) };
}
