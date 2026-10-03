/*
 * Load face-api in Node for the command-line tools.
 *
 * The vendored build is the browser ES module. Two adjustments let it run here
 * on TensorFlow.js's pure-JavaScript CPU backend, with no native addon:
 *
 * - TensorFlow.js picks its Node platform whenever `document` is missing, and
 *   that platform needs the real `util` module, which the browser bundle stubs
 *   out. A placeholder `document` keeps it on the browser platform. Inputs are
 *   always tensors, so nothing ever touches the DOM.
 * - The bundle's dynamic-require shim looks for a global `require`.
 *
 * Weights are read straight from models/ rather than fetched.
 */

import './browser-shim.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installFaceApi } from '../js/facecode.js';

if (typeof globalThis.require === 'undefined') globalThis.require = createRequire(import.meta.url);
if (typeof globalThis.document === 'undefined') globalThis.document = {};

const MODEL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');

function weightMap(tf, name) {
	const manifest = JSON.parse(readFileSync(join(MODEL_DIR, `${name}-weights_manifest.json`), 'utf8'));
	const specs = manifest.flatMap(group => group.weights);
	const joined = Buffer.concat(manifest.flatMap(group => group.paths.map(path => readFileSync(join(MODEL_DIR, path)))));
	return tf.io.decodeWeights(joined.buffer.slice(joined.byteOffset, joined.byteOffset + joined.length), specs);
}

export async function loadNodeFaceApi() {
	const faceapi = await import('../js/lib/face-api.esm.js');
	const { tf } = faceapi;
	await tf.setBackend('cpu');
	await tf.ready();
	faceapi.nets.tinyFaceDetector.loadFromWeightMap(weightMap(tf, 'tiny_face_detector_model'));
	faceapi.nets.faceLandmark68Net.loadFromWeightMap(weightMap(tf, 'face_landmark_68_model'));
	faceapi.nets.faceRecognitionNet.loadFromWeightMap(weightMap(tf, 'face_recognition_model'));
	installFaceApi(faceapi);
	return faceapi;
}

/** Read one of the samples/*.rgba dumps: two big-endian u32 dimensions, then RGBA. */
export function readRgbaDump(path) {
	const buffer = readFileSync(path);
	const width = buffer.readUInt32BE(0);
	const height = buffer.readUInt32BE(4);
	return { width, height, data: new Uint8ClampedArray(buffer.buffer, buffer.byteOffset + 8, width * height * 4) };
}

/** Decode an uncompressed 24- or 32-bit BMP into RGBA. */
export function readBmp(path) {
	const buffer = readFileSync(path);
	if (buffer.toString('ascii', 0, 2) !== 'BM') throw new Error(`${path} is not a BMP file`);
	const offset = buffer.readUInt32LE(10);
	const width = buffer.readInt32LE(18);
	const rawHeight = buffer.readInt32LE(22);
	const height = Math.abs(rawHeight);
	const bytesPerPixel = buffer.readUInt16LE(28) / 8;
	if (bytesPerPixel !== 3 && bytesPerPixel !== 4) throw new Error(`${path}: only 24/32-bit BMP is supported`);
	const stride = Math.ceil((width * bytesPerPixel) / 4) * 4;
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const row = offset + (rawHeight < 0 ? y : height - 1 - y) * stride;
		for (let x = 0; x < width; x++) {
			const p = row + x * bytesPerPixel;
			const q = (y * width + x) * 4;
			data[q] = buffer[p + 2];
			data[q + 1] = buffer[p + 1];
			data[q + 2] = buffer[p];
			data[q + 3] = 255;
		}
	}
	return { width, height, data };
}

/** Silence TensorFlow.js's one-off "install tfjs-node" banner. */
export function quietTfBanner() {
	for (const level of ['log', 'warn', 'info']) {
		const original = console[level];
		console[level] = (...args) => {
			const text = String(args[0] ?? '');
			if (text.includes('tfjs-node') || /^=+$/.test(text.trim()) || text.startsWith('\n====')) return;
			original(...args);
		};
	}
}
