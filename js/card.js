'use strict';

/*
 * Card geometry and the portrait normalisation shared by the issuer and the
 * scanner.
 *
 * The issuer and the verifier must hash pixel-for-pixel comparable images or
 * the Hamming distance is meaningless, so every portrait — whether uploaded at
 * issuance or recaptured through a camera — is funnelled through
 * `canonicalPortrait()` before it reaches the hash function.
 */

// ID-1, the ISO/IEC 7810 bank-card size, in millimetres.
export const CARD = { width: 85.6, height: 54 };

/*
 * Millimetre rectangles measured from the top-left corner of the card face.
 * The scanner relies on these being fixed: once the QR's four corners are
 * located in a camera frame, the portrait rectangle follows from the geometry.
 *
 * The QR is deliberately large. A signed MV2 payload encodes to a version 10
 * symbol (57 modules) and MV3 to version 11 (61 modules); at 25 mm that is
 * about 0.44 mm and 0.41 mm per module, which prints cleanly and stays within
 * reach of a phone camera.
 * Shrinking this rectangle is the quickest way to make cards unscannable.
 */
export const PORTRAIT_RECT = { x: 5, y: 14, width: 19.5, height: 26 };
export const QR_RECT = { x: 56.5, y: 14, width: 25, height: 25 };

// Clear space that must stay blank around the QR, in millimetres. The QR spec
// asks for four modules; at 0.41 mm per module that is about 1.7 mm.
export const QR_QUIET_ZONE = 2.5;

/*
 * Publish the geometry to CSS so the printed card and the scanner's homography
 * are driven by one set of numbers. Called at module load by every page that
 * renders a card, before first paint.
 */
export function applyCardGeometry(root = document.documentElement) {
	const mm = value => `${value}mm`;
	const variables = {
		'--card-w': CARD.width,
		'--card-h': CARD.height,
		'--portrait-x': PORTRAIT_RECT.x,
		'--portrait-y': PORTRAIT_RECT.y,
		'--portrait-w': PORTRAIT_RECT.width,
		'--portrait-h': PORTRAIT_RECT.height,
		'--qr-x': QR_RECT.x,
		'--qr-y': QR_RECT.y,
		'--qr-w': QR_RECT.width,
		'--qr-h': QR_RECT.height,
		'--qr-quiet': QR_QUIET_ZONE
	};
	for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, mm(value));
}

// The canonical portrait raster. 3:4, matching PORTRAIT_RECT's aspect ratio.
export const PORTRAIT_PIXELS = { width: 300, height: 400 };

export const PORTRAIT_ASPECT = PORTRAIT_PIXELS.width / PORTRAIT_PIXELS.height;

/** The largest rectangle of the given aspect ratio, centred in w x h. */
export function centreCrop(width, height, aspect = PORTRAIT_ASPECT) {
	let cropWidth = width;
	let cropHeight = width / aspect;
	if (cropHeight > height) {
		cropHeight = height;
		cropWidth = height * aspect;
	}
	return {
		x: (width - cropWidth) / 2,
		y: (height - cropHeight) / 2,
		width: cropWidth,
		height: cropHeight
	};
}

export function clampCrop(crop, width, height) {
	const w = Math.min(crop.width, width);
	const h = Math.min(crop.height, height);
	return {
		x: Math.min(Math.max(0, crop.x), width - w),
		y: Math.min(Math.max(0, crop.y), height - h),
		width: w,
		height: h
	};
}

function createCanvas(width, height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function toGrayscale(imageData) {
	const { data } = imageData;
	for (let p = 0; p < data.length; p += 4) {
		const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
		data[p] = data[p + 1] = data[p + 2] = y;
		data[p + 3] = 255;
	}
	return imageData;
}

/**
 * Crop `source` to `crop`, scale it to the canonical 300x400 raster and
 * desaturate it. The card prints exactly this image, so what gets hashed at
 * issuance is what a verifier's camera later sees.
 *
 * @param {CanvasImageSource} source an <img>, <video> or <canvas>
 * @param {{x:number,y:number,width:number,height:number}} crop region of the source, in source pixels
 * @returns {{imageData: ImageData, canvas: HTMLCanvasElement, dataUrl: string}}
 */
export function canonicalPortrait(source, crop) {
	const canvas = createCanvas(PORTRAIT_PIXELS.width, PORTRAIT_PIXELS.height);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(
		source,
		crop.x, crop.y, crop.width, crop.height,
		0, 0, PORTRAIT_PIXELS.width, PORTRAIT_PIXELS.height
	);

	const imageData = toGrayscale(ctx.getImageData(0, 0, canvas.width, canvas.height));
	ctx.putImageData(imageData, 0, 0);

	return { imageData, canvas, dataUrl: canvas.toDataURL('image/png') };
}

/* ------------------------------------------------------------------ *
 * Perspective correction
 * ------------------------------------------------------------------ */

// Gaussian elimination with partial pivoting on an n x (n+1) augmented matrix.
function solveLinearSystem(matrix, n) {
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
		}
		if (Math.abs(matrix[pivot][col]) < 1e-12) return null;
		[matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];

		const lead = matrix[col][col];
		for (let k = col; k <= n; k++) matrix[col][k] /= lead;

		for (let row = 0; row < n; row++) {
			if (row === col) continue;
			const factor = matrix[row][col];
			if (factor === 0) continue;
			for (let k = col; k <= n; k++) matrix[row][k] -= factor * matrix[col][k];
		}
	}
	return matrix.map(row => row[n]);
}

/**
 * The 3x3 homography taking four source points to four destination points.
 * Returns a row-major array of 9 numbers, or null if the points are degenerate.
 */
export function homography(from, to) {
	if (from.length !== 4 || to.length !== 4) throw new Error('homography needs exactly 4 point pairs');

	const rows = [];
	for (let i = 0; i < 4; i++) {
		const { x, y } = from[i];
		const { x: X, y: Y } = to[i];
		rows.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
		rows.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
	}

	const h = solveLinearSystem(rows, 8);
	if (!h) return null;
	return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function applyHomography(h, x, y) {
	const w = h[6] * x + h[7] * y + h[8];
	if (Math.abs(w) < 1e-12) return null;
	return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

function sampleBilinear(source, x, y, channel) {
	const { data, width, height } = source;
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const cx0 = Math.min(width - 1, Math.max(0, x0));
	const cy0 = Math.min(height - 1, Math.max(0, y0));
	const cx1 = Math.min(width - 1, cx0 + 1);
	const cy1 = Math.min(height - 1, cy0 + 1);

	const tl = data[(cy0 * width + cx0) * 4 + channel];
	const tr = data[(cy0 * width + cx1) * 4 + channel];
	const bl = data[(cy1 * width + cx0) * 4 + channel];
	const br = data[(cy1 * width + cx1) * 4 + channel];

	return (tl * (1 - fx) + tr * fx) * (1 - fy) + (bl * (1 - fx) + br * fx) * fy;
}

/** The four corners of a millimetre rectangle, clockwise from the top left. */
export function rectCorners(rect) {
	return [
		{ x: rect.x, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y },
		{ x: rect.x + rect.width, y: rect.y + rect.height },
		{ x: rect.x, y: rect.y + rect.height }
	];
}

/**
 * Recover the canonical portrait from a photograph of a whole card.
 *
 * jsQR reports the QR symbol's four corners in frame pixels. Because the QR
 * occupies a known millimetre rectangle on a rigid card, those four
 * correspondences pin down the homography from card millimetres to frame
 * pixels, and the portrait rectangle can then be inverse-warped out of the
 * frame with perspective and rotation removed.
 *
 * @param {ImageData} frame the full camera frame or uploaded photo
 * @param {{topLeftCorner,topRightCorner,bottomRightCorner,bottomLeftCorner}} location jsQR's `location`
 * @returns {{imageData: ImageData, canvas: HTMLCanvasElement, dataUrl: string}|null}
 */
export function portraitFromCardPhoto(frame, location) {
	const framePoints = [
		location.topLeftCorner,
		location.topRightCorner,
		location.bottomRightCorner,
		location.bottomLeftCorner
	];
	if (framePoints.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;

	const h = homography(rectCorners(QR_RECT), framePoints);
	if (!h) return null;

	const { width: outWidth, height: outHeight } = PORTRAIT_PIXELS;
	const canvas = createCanvas(outWidth, outHeight);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	const out = ctx.createImageData(outWidth, outHeight);

	let sampled = 0;
	for (let v = 0; v < outHeight; v++) {
		const mmY = PORTRAIT_RECT.y + ((v + 0.5) / outHeight) * PORTRAIT_RECT.height;
		for (let u = 0; u < outWidth; u++) {
			const mmX = PORTRAIT_RECT.x + ((u + 0.5) / outWidth) * PORTRAIT_RECT.width;
			const point = applyHomography(h, mmX, mmY);
			const p = (v * outWidth + u) * 4;

			if (!point || point.x < 0 || point.y < 0 || point.x >= frame.width || point.y >= frame.height) {
				out.data[p] = out.data[p + 1] = out.data[p + 2] = 0;
				out.data[p + 3] = 255;
				continue;
			}

			sampled++;
			const r = sampleBilinear(frame, point.x, point.y, 0);
			const g = sampleBilinear(frame, point.x, point.y, 1);
			const b = sampleBilinear(frame, point.x, point.y, 2);
			const y = 0.299 * r + 0.587 * g + 0.114 * b;
			out.data[p] = out.data[p + 1] = out.data[p + 2] = y;
			out.data[p + 3] = 255;
		}
	}

	// If most of the portrait fell outside the frame the card was cropped or the
	// QR was misread; a hash of mostly-black pixels would be worse than nothing.
	if (sampled < outWidth * outHeight * 0.7) return null;

	ctx.putImageData(out, 0, 0);
	return { imageData: out, canvas, dataUrl: canvas.toDataURL('image/png'), coverage: sampled / (outWidth * outHeight) };
}

/** Pull an ImageData for a whole video frame or image element. */
export function frameToImageData(source, width, height) {
	const canvas = createCanvas(width, height);
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	ctx.drawImage(source, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}
