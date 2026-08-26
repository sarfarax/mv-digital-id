'use strict';

/*
 * A JavaScript port of pHash.org's DCT image hash (`ph_dct_imagehash` from
 * pHash 0.9.6, phash.cpp). The pipeline is:
 *
 *   1. luminance (CImg RGBtoYCbCr channel 0)
 *   2. 7x7 mean filter
 *   3. resample to 32x32
 *   4. DCT via the ph_dct_matrix basis, D = C * img * C^T
 *   5. take the 8x8 block at offset (1,1), skipping the DC row and column
 *   6. one bit per coefficient: set when the coefficient exceeds the median
 *
 * The result is 64 bits, rendered as 16 lowercase hex characters, and two
 * hashes are compared by Hamming distance.
 */

export const HASH_BITS = 64;
export const DCT_SIZE = 32;

/*
 * pHash convolves with a 7x7 kernel of ones, which sums rather than averages.
 * Dividing by the kernel area instead scales every DCT coefficient by the same
 * constant, so the median comparison in step 6 is unchanged. Averaging is used
 * here because it keeps the values in the original 0..255 range.
 */
const MEAN_FILTER_RADIUS = 3;

function luminance(imageData) {
	const { data, width, height } = imageData;
	const out = new Float64Array(width * height);
	for (let i = 0, p = 0; i < out.length; i++, p += 4) {
		out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
	}
	return { data: out, width, height };
}

// Separable box blur; a 1D pass on each axis is equivalent to the 2D 7x7 mean.
// Edges use replicated (Neumann) samples, matching CImg's default.
function meanFilter(plane, radius = MEAN_FILTER_RADIUS) {
	const { width, height } = plane;
	const window = radius * 2 + 1;
	const horizontal = new Float64Array(width * height);
	const src = plane.data;

	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const sx = Math.min(width - 1, Math.max(0, x + k));
				sum += src[row + sx];
			}
			horizontal[row + x] = sum / window;
		}
	}

	const out = new Float64Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			for (let k = -radius; k <= radius; k++) {
				const sy = Math.min(height - 1, Math.max(0, y + k));
				sum += horizontal[sy * width + x];
			}
			out[y * width + x] = sum / window;
		}
	}

	return { data: out, width, height };
}

/*
 * Area-average resampling. pHash relies on CImg's default nearest-neighbour
 * resize, but nearest-neighbour discards most pixels on a large downscale and
 * makes the hash jitter under sub-pixel shifts, which is exactly the noise a
 * camera introduces. Averaging is deterministic and both the issuer and the
 * verifier run this same function, so the two sides stay consistent.
 */
function resampleArea(plane, dstWidth, dstHeight) {
	const { data, width, height } = plane;
	const out = new Float64Array(dstWidth * dstHeight);
	const scaleX = width / dstWidth;
	const scaleY = height / dstHeight;

	for (let dy = 0; dy < dstHeight; dy++) {
		const y0 = dy * scaleY;
		const y1 = y0 + scaleY;
		const iy0 = Math.floor(y0);
		const iy1 = Math.min(height, Math.ceil(y1));

		for (let dx = 0; dx < dstWidth; dx++) {
			const x0 = dx * scaleX;
			const x1 = x0 + scaleX;
			const ix0 = Math.floor(x0);
			const ix1 = Math.min(width, Math.ceil(x1));

			let sum = 0;
			let weightSum = 0;
			for (let y = iy0; y < iy1; y++) {
				const wy = Math.min(y + 1, y1) - Math.max(y, y0);
				if (wy <= 0) continue;
				for (let x = ix0; x < ix1; x++) {
					const wx = Math.min(x + 1, x1) - Math.max(x, x0);
					if (wx <= 0) continue;
					const weight = wx * wy;
					sum += data[y * width + x] * weight;
					weightSum += weight;
				}
			}
			out[dy * dstWidth + dx] = weightSum > 0 ? sum / weightSum : 0;
		}
	}

	return { data: out, width: dstWidth, height: dstHeight };
}

// pHash's ph_dct_matrix: row 0 is the constant 1/sqrt(N), every later row y is
// sqrt(2/N) * cos(pi/(2N) * y * (2x+1)). Stored row-major as m[y * N + x].
function dctMatrix(n) {
	const m = new Float64Array(n * n);
	const dc = 1 / Math.sqrt(n);
	const ac = Math.sqrt(2 / n);
	const k = Math.PI / (2 * n);

	for (let x = 0; x < n; x++) m[x] = dc;
	for (let y = 1; y < n; y++) {
		for (let x = 0; x < n; x++) {
			m[y * n + x] = ac * Math.cos(k * y * (2 * x + 1));
		}
	}
	return m;
}

function multiply(a, b, n) {
	const out = new Float64Array(n * n);
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < n; k++) {
			const aik = a[i * n + k];
			if (aik === 0) continue;
			for (let j = 0; j < n; j++) {
				out[i * n + j] += aik * b[k * n + j];
			}
		}
	}
	return out;
}

function transpose(m, n) {
	const out = new Float64Array(n * n);
	for (let y = 0; y < n; y++) {
		for (let x = 0; x < n; x++) out[x * n + y] = m[y * n + x];
	}
	return out;
}

// CImg's median averages the two central values for an even-sized set.
function median(values) {
	const sorted = Float64Array.from(values).sort();
	const n = sorted.length;
	if (n % 2 === 1) return sorted[n >> 1];
	return (sorted[(n >> 1) - 1] + sorted[n >> 1]) / 2;
}

let cachedBasis = null;
function basis() {
	if (!cachedBasis) {
		const c = dctMatrix(DCT_SIZE);
		cachedBasis = { c, ct: transpose(c, DCT_SIZE) };
	}
	return cachedBasis;
}

/**
 * Compute the perceptual hash of an ImageData.
 *
 * @param {ImageData} imageData source pixels, any size
 * @returns {{hex: string, preview: {data: Float64Array, width: number, height: number}}}
 *   `hex` is the 64-bit hash as 16 lowercase hex characters. `preview` is the
 *   32x32 luminance stage, useful for showing operators what was actually hashed.
 */
export function pHash(imageData) {
	const gray = luminance(imageData);
	const smoothed = meanFilter(gray);
	const small = resampleArea(smoothed, DCT_SIZE, DCT_SIZE);

	const { c, ct } = basis();
	const dct = multiply(multiply(c, small.data, DCT_SIZE), ct, DCT_SIZE);

	// crop(1,1,8,8) in CImg is inclusive, so this is the 8x8 block that skips
	// the DC row and column.
	const coefficients = new Float64Array(HASH_BITS);
	let i = 0;
	for (let y = 1; y <= 8; y++) {
		for (let x = 1; x <= 8; x++) coefficients[i++] = dct[y * DCT_SIZE + x];
	}

	const threshold = median(coefficients);
	let bits = 0n;
	for (let bit = 0; bit < HASH_BITS; bit++) {
		if (coefficients[bit] > threshold) bits |= 1n << BigInt(bit);
	}

	return { hex: bits.toString(16).padStart(HASH_BITS / 4, '0'), preview: small };
}

export function pHashHex(imageData) {
	return pHash(imageData).hex;
}

export function isValidHash(hex) {
	return typeof hex === 'string' && new RegExp(`^[0-9a-f]{${HASH_BITS / 4}}$`).test(hex);
}

/** Number of differing bits between two hashes, in the range 0..64. */
export function hammingDistance(a, b) {
	if (!isValidHash(a) || !isValidHash(b)) {
		throw new Error('hammingDistance expects two 16-character hex hashes');
	}
	let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
	let count = 0;
	while (diff > 0n) {
		count += Number(diff & 1n);
		diff >>= 1n;
	}
	return count;
}

/** Rough similarity in the range 0..1, for display alongside the raw distance. */
export function similarity(a, b) {
	return 1 - hammingDistance(a, b) / HASH_BITS;
}
