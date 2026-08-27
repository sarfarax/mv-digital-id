'use strict';

/*
 * Browser-side pipeline tests.
 *
 * The Node self-tests under tools/ cover the hash and the payload in isolation.
 * What they cannot cover is everything that needs a canvas: drawing a real QR
 * code onto a card, photographing that card, finding the code again, and
 * recovering the portrait through the homography. That is what runs here.
 */

import {
	CARD,
	PORTRAIT_RECT,
	QR_RECT,
	canonicalPortrait,
	centreCrop,
	homography,
	applyHomography,
	rectCorners,
	portraitFromCardPhoto,
	frameToImageData
} from './card.js';
import { pHashHex, hammingDistance } from './phash.js';
import {
	buildMessage,
	signMessage,
	joinBarcodeData,
	splitBarcodeData,
	encodeBarcode,
	readAndVerify,
	expiryStatus,
	ENCODING_BINARY,
	ENCODING_TEXT
} from './payload.js';
import { DEMO_SECRET_KEY, ISSUER } from './issuer-key.js';

const MATCH_THRESHOLD = 12;

const resultsEl = document.getElementById('results');
const summaryEl = document.getElementById('summary');
const stagesEl = document.getElementById('stages');

const results = [];

function group(title) {
	const el = document.createElement('div');
	el.className = 'test-group';
	el.textContent = title;
	resultsEl.append(el);
}

function record(label, passed, detail = '') {
	results.push(passed);
	const row = document.createElement('div');
	row.className = 'test-row';
	row.innerHTML = `
		<span class="badge ${passed ? 'badge--ok' : 'badge--fail'}">${passed ? 'PASS' : 'FAIL'}</span>
		<span>${label}</span>
		<span class="test-row__detail">${detail}</span>`;
	resultsEl.append(row);
	return passed;
}

function showStage(caption, canvas) {
	const figure = document.createElement('figure');
	const clone = document.createElement('canvas');
	clone.width = canvas.width;
	clone.height = canvas.height;
	clone.getContext('2d').drawImage(canvas, 0, 0);
	figure.append(clone);
	const cap = document.createElement('figcaption');
	cap.textContent = caption;
	figure.append(cap);
	stagesEl.append(figure);
}

function loadImage(src) {
	return new Promise((resolve, reject) => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => reject(new Error(`could not load ${src}`));
		image.src = src;
	});
}

function makeCanvas(width, height) {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

/* ------------------------------------------------------------------ *
 * Synthesise a printed card and a photograph of one
 * ------------------------------------------------------------------ */

/*
 * Draw the card at a known scale. Only the two things the scanner depends on
 * have to be exact: the portrait and the QR must sit precisely on the
 * millimetre rectangles in card.js. Everything else is decoration.
 */
function renderCard(portraitSource, qr, pixelsPerMm = 12) {
	const canvas = makeCanvas(Math.round(CARD.width * pixelsPerMm), Math.round(CARD.height * pixelsPerMm));
	const ctx = canvas.getContext('2d');
	const navy = '#0c3b7c';
	const navyDeep = '#0a3268';

	ctx.fillStyle = navy;
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.fillStyle = '#f7f9fc';
	ctx.fillRect(1.15 * pixelsPerMm, 1.15 * pixelsPerMm,
		canvas.width - 2.3 * pixelsPerMm, canvas.height - 2.3 * pixelsPerMm);

	ctx.fillStyle = navyDeep;
	ctx.fillRect(0, 0, canvas.width, 11 * pixelsPerMm);
	ctx.fillStyle = '#f0c419';
	ctx.fillRect(0, 11 * pixelsPerMm - 0.55 * pixelsPerMm, canvas.width, 0.55 * pixelsPerMm);

	ctx.fillStyle = '#ffffff';
	ctx.font = `700 ${2.95 * pixelsPerMm}px system-ui, sans-serif`;
	ctx.fillText('REPUBLIC OF MALDIVES', 3.5 * pixelsPerMm, 4.6 * pixelsPerMm);
	ctx.font = `550 ${2.15 * pixelsPerMm}px system-ui, sans-serif`;
	ctx.fillStyle = '#d2e0f5';
	ctx.fillText('NATIONAL IDENTITY CARD', 3.5 * pixelsPerMm, 8.0 * pixelsPerMm);

	ctx.fillStyle = navy;
	ctx.fillRect(
		PORTRAIT_RECT.x * pixelsPerMm - 2,
		PORTRAIT_RECT.y * pixelsPerMm - 2,
		PORTRAIT_RECT.width * pixelsPerMm + 4,
		PORTRAIT_RECT.height * pixelsPerMm + 4
	);
	ctx.drawImage(
		portraitSource,
		PORTRAIT_RECT.x * pixelsPerMm,
		PORTRAIT_RECT.y * pixelsPerMm,
		PORTRAIT_RECT.width * pixelsPerMm,
		PORTRAIT_RECT.height * pixelsPerMm
	);

	ctx.fillStyle = navy;
	ctx.font = `700 ${3.15 * pixelsPerMm}px ui-monospace, monospace`;
	ctx.fillText(CARDHOLDER.idNumber, 27 * pixelsPerMm, 17 * pixelsPerMm);
	ctx.font = `700 ${1.7 * pixelsPerMm}px system-ui, sans-serif`;
	ctx.fillText('NAME', 27 * pixelsPerMm, 20.5 * pixelsPerMm);
	ctx.fillText('DATE OF BIRTH', 27 * pixelsPerMm, 27 * pixelsPerMm);
	ctx.fillText('PERMANENT ADDRESS', 27 * pixelsPerMm, 33.5 * pixelsPerMm);

	const qrCanvas = makeCanvas(1, 1);
	qr.drawCanvas(8, 0, qrCanvas);

	ctx.fillStyle = navy;
	ctx.fillRect(
		(QR_RECT.x - 2.5) * pixelsPerMm - 1,
		(QR_RECT.y - 2.5) * pixelsPerMm - 1,
		(QR_RECT.width + 5) * pixelsPerMm + 2,
		(QR_RECT.height + 5) * pixelsPerMm + 2
	);
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(
		(QR_RECT.x - 2.5) * pixelsPerMm,
		(QR_RECT.y - 2.5) * pixelsPerMm,
		(QR_RECT.width + 5) * pixelsPerMm,
		(QR_RECT.height + 5) * pixelsPerMm
	);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(
		qrCanvas,
		QR_RECT.x * pixelsPerMm,
		QR_RECT.y * pixelsPerMm,
		QR_RECT.width * pixelsPerMm,
		QR_RECT.height * pixelsPerMm
	);
	ctx.imageSmoothingEnabled = true;

	ctx.fillStyle = navy;
	ctx.fillRect(0, canvas.height - 4.2 * pixelsPerMm, canvas.width, 4.2 * pixelsPerMm);

	return canvas;
}

/*
 * Fake a photograph: place the card into a larger frame at an arbitrary
 * quadrilateral, so the scanner has to cope with perspective, rotation and
 * surrounding background rather than a clean scan.
 */
function photographCard(cardCanvas, quad, outWidth, outHeight, { noise = 0, brightness = 1, offset = 0 } = {}) {
	const source = cardCanvas.getContext('2d').getImageData(0, 0, cardCanvas.width, cardCanvas.height);
	const out = makeCanvas(outWidth, outHeight);
	const ctx = out.getContext('2d');

	// Desk background.
	const gradient = ctx.createLinearGradient(0, 0, outWidth, outHeight);
	gradient.addColorStop(0, '#5c6672');
	gradient.addColorStop(1, '#39424d');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, outWidth, outHeight);

	const target = ctx.getImageData(0, 0, outWidth, outHeight);

	// Map destination pixels back into the card image.
	const toCard = homography(quad, [
		{ x: 0, y: 0 },
		{ x: cardCanvas.width, y: 0 },
		{ x: cardCanvas.width, y: cardCanvas.height },
		{ x: 0, y: cardCanvas.height }
	]);
	if (!toCard) throw new Error('degenerate photograph quad');

	const minX = Math.max(0, Math.floor(Math.min(...quad.map(p => p.x))));
	const maxX = Math.min(outWidth, Math.ceil(Math.max(...quad.map(p => p.x))));
	const minY = Math.max(0, Math.floor(Math.min(...quad.map(p => p.y))));
	const maxY = Math.min(outHeight, Math.ceil(Math.max(...quad.map(p => p.y))));

	for (let y = minY; y < maxY; y++) {
		for (let x = minX; x < maxX; x++) {
			const point = applyHomography(toCard, x + 0.5, y + 0.5);
			if (!point) continue;
			const sx = Math.round(point.x);
			const sy = Math.round(point.y);
			if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;

			const from = (sy * source.width + sx) * 4;
			const to = (y * outWidth + x) * 4;
			const jitter = noise ? (Math.random() - 0.5) * noise : 0;
			for (let c = 0; c < 3; c++) {
				target.data[to + c] = Math.max(0, Math.min(255, source.data[from + c] * brightness + offset + jitter));
			}
			target.data[to + 3] = 255;
		}
	}

	ctx.putImageData(target, 0, 0);
	return out;
}

function decodeFrom(canvas) {
	const imageData = frameToImageData(canvas, canvas.width, canvas.height);
	const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });
	return { imageData, code };
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

// Relative so the fixtures keep their meaning however long this sits unrun.
const isoDaysFromNow = days => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const CARDHOLDER = {
	idNumber: 'A123456',
	name: 'Aishath Nasheeda Ibrahim',
	sex: 'F',
	dob: '1991-04-17',
	expiry: isoDaysFromNow(3650),
	address: 'Ma. Blue Heaven, Male, Maldives'
};

async function run() {
	resultsEl.innerHTML = '';
	stagesEl.innerHTML = '';
	summaryEl.innerHTML = '';
	results.length = 0;

	const [personA, personB] = await Promise.all([
		loadImage('samples/portrait-2.jpg'),
		loadImage('samples/portrait-1.jpg')
	]);

	/* ---------------- perceptual hash ---------------- */
	group('Perceptual hash');

	const portraitA = canonicalPortrait(personA, centreCrop(personA.naturalWidth, personA.naturalHeight));
	const portraitB = canonicalPortrait(personB, centreCrop(personB.naturalWidth, personB.naturalHeight));

	// Mild synthetic recapture: brightness + noise on the canonical raster.
	const recaptureCanvas = makeCanvas(portraitA.canvas.width, portraitA.canvas.height);
	{
		const ctx = recaptureCanvas.getContext('2d');
		ctx.filter = 'brightness(0.92) contrast(1.05)';
		ctx.drawImage(portraitA.canvas, 0, 0);
		ctx.filter = 'none';
		const pixels = ctx.getImageData(0, 0, recaptureCanvas.width, recaptureCanvas.height);
		for (let i = 0; i < pixels.data.length; i += 4) {
			const n = ((i * 1103515245 + 12345) >>> 16) & 31;
			pixels.data[i] = Math.max(0, Math.min(255, pixels.data[i] + n - 15));
			pixels.data[i + 1] = pixels.data[i];
			pixels.data[i + 2] = pixels.data[i];
		}
		ctx.putImageData(pixels, 0, 0);
	}
	const portraitARecaptured = {
		canvas: recaptureCanvas,
		imageData: recaptureCanvas.getContext('2d').getImageData(0, 0, recaptureCanvas.width, recaptureCanvas.height)
	};

	const hashA = pHashHex(portraitA.imageData);
	const hashB = pHashHex(portraitB.imageData);
	const hashARecaptured = pHashHex(portraitARecaptured.imageData);

	showStage('Portrait A, normalised', portraitA.canvas);
	showStage('Portrait B, normalised', portraitB.canvas);

	record('hash is 16 hex characters', /^[0-9a-f]{16}$/.test(hashA), hashA);
	record('hashing is deterministic', pHashHex(portraitA.imageData) === hashA, hashA);
	record('degraded recapture of A still matches A',
		hammingDistance(hashA, hashARecaptured) <= MATCH_THRESHOLD,
		`distance ${hammingDistance(hashA, hashARecaptured)}`);
	record('B does not match A',
		hammingDistance(hashA, hashB) > MATCH_THRESHOLD,
		`distance ${hammingDistance(hashA, hashB)}`);

	/* ---------------- signing ---------------- */
	group('Signing');

	const message = buildMessage(CARDHOLDER, hashA);
	const signature = await signMessage(message, DEMO_SECRET_KEY);
	const barcodeData = joinBarcodeData(message, signature);

	record('signature is 192 hex characters', signature.length === 192, `${signature.length} chars`);

	/* ---------------- QR round trip ---------------- */
	group('QR round trip');

	for (const mode of [ENCODING_BINARY, ENCODING_TEXT]) {
		const encoded = encodeBarcode(barcodeData, mode);
		const canvas = makeCanvas(1, 1);
		encoded.qr.drawCanvas(6, 4, canvas);

		const { code } = decodeFrom(canvas);
		if (!code) {
			record(`${mode}: QR decodes`, false, 'no code found');
			continue;
		}
		record(`${mode}: QR decodes`, true, `v${encoded.qr.version}, ${encoded.byteLength} bytes`);

		const verified = await readAndVerify(code, ISSUER.publicKey);
		record(`${mode}: signature verifies after decoding`, verified.ok === true, verified.error ?? '');
		record(`${mode}: fields survive the round trip`, verified.fields?.name === CARDHOLDER.name, verified.fields?.name ?? '');
	}

	/* ---------------- a genuine card, scanned flat ---------------- */
	group('Genuine card, scanned flat');

	const encoded = encodeBarcode(barcodeData, ENCODING_BINARY);
	const cardCanvas = renderCard(portraitA.canvas, encoded.qr);
	showStage('Rendered card', cardCanvas);

	const flat = decodeFrom(cardCanvas);
	if (record('QR found on the card', Boolean(flat.code))) {
		const verified = await readAndVerify(flat.code, ISSUER.publicKey);
		record('signature valid', verified.ok === true, verified.error ?? '');

		const recovered = portraitFromCardPhoto(flat.imageData, flat.code.location);
		if (record('portrait recovered from card geometry', Boolean(recovered))) {
			showStage('Portrait recovered, flat', recovered.canvas);
			const distance = hammingDistance(verified.photoHash, pHashHex(recovered.imageData));
			record('recovered portrait matches the signed hash', distance <= MATCH_THRESHOLD, `distance ${distance}`);
		}
	}

	/* ---------------- a genuine card, photographed at an angle ---------------- */
	group('Genuine card, photographed at an angle');

	const angled = photographCard(
		cardCanvas,
		[{ x: 180, y: 150 }, { x: 1080, y: 95 }, { x: 1150, y: 640 }, { x: 140, y: 590 }],
		1280, 800,
		{ noise: 14, brightness: 0.9, offset: 12 }
	);
	showStage('Simulated photograph', angled);

	const skewed = decodeFrom(angled);
	if (record('QR found in the photograph', Boolean(skewed.code))) {
		const verified = await readAndVerify(skewed.code, ISSUER.publicKey);
		record('signature valid from the photograph', verified.ok === true, verified.error ?? '');

		const recovered = portraitFromCardPhoto(skewed.imageData, skewed.code.location);
		if (record('portrait recovered despite perspective', Boolean(recovered))) {
			showStage('Portrait recovered, angled', recovered.canvas);
			const distance = hammingDistance(verified.photoHash, pHashHex(recovered.imageData));
			record('portrait still matches the signed hash', distance <= MATCH_THRESHOLD, `distance ${distance}`);
		}
	}

	/* ---------------- a forged card ---------------- */
	group('Forged card: portrait swapped, QR untouched');

	const forged = renderCard(portraitB.canvas, encoded.qr);
	showStage('Forged card (different face)', forged);

	const forgedScan = decodeFrom(forged);
	if (record('QR still readable on the forgery', Boolean(forgedScan.code))) {
		const verified = await readAndVerify(forgedScan.code, ISSUER.publicKey);
		record('signature still valid (the QR was not touched)', verified.ok === true,
			'this is why the portrait check exists');

		const recovered = portraitFromCardPhoto(forgedScan.imageData, forgedScan.code.location);
		if (record('portrait recovered from the forgery', Boolean(recovered))) {
			showStage('Portrait recovered, forgery', recovered.canvas);
			const distance = hammingDistance(verified.photoHash, pHashHex(recovered.imageData));
			record('forged portrait is rejected', distance > MATCH_THRESHOLD, `distance ${distance}`);
		}
	}

	/* ---------------- an expired card ---------------- */
	group('Expired card: correctly signed, out of date');

	const expiredHolder = { ...CARDHOLDER, expiry: isoDaysFromNow(-30) };
	const expiredMessage = buildMessage(expiredHolder, hashA);
	const expiredSignature = await signMessage(expiredMessage, DEMO_SECRET_KEY);
	const expiredEncoded = encodeBarcode(joinBarcodeData(expiredMessage, expiredSignature), ENCODING_BINARY);
	const expiredCard = renderCard(portraitA.canvas, expiredEncoded.qr);
	showStage('Expired card', expiredCard);

	const expiredScan = decodeFrom(expiredCard);
	if (record('QR readable on the expired card', Boolean(expiredScan.code))) {
		const verified = await readAndVerify(expiredScan.code, ISSUER.publicKey);
		record('signature is genuinely valid', verified.ok === true,
			'nothing cryptographic is wrong with an expired card');

		const recovered = portraitFromCardPhoto(expiredScan.imageData, expiredScan.code.location);
		if (recovered) {
			const distance = hammingDistance(verified.photoHash, pHashHex(recovered.imageData));
			record('portrait matches too', distance <= MATCH_THRESHOLD, `distance ${distance}`);
		}

		const status = expiryStatus(verified.fields?.expiry);
		record('expiry check rejects it anyway', status.state === 'expired',
			`expired ${verified.fields?.expiry}`);
	}

	record('an in-date card passes the expiry check',
		expiryStatus(CARDHOLDER.expiry).state === 'valid', CARDHOLDER.expiry);
	record('a card expiring today is still valid',
		expiryStatus(isoDaysFromNow(0)).state === 'valid', isoDaysFromNow(0));

	/* ---------------- tampered payload ---------------- */
	group('Tampered payload');

	const cases = {
		'altered name': barcodeData.replace(CARDHOLDER.name, 'Mohamed Imposter Ali'),
		'altered date of birth': barcodeData.replace(CARDHOLDER.dob, '2001-04-17'),
		'altered address': barcodeData.replace('Blue Heaven', 'Gold Heaven'),
		'substituted portrait hash': barcodeData.replace(hashA, hashB)
	};

	for (const [label, mutated] of Object.entries(cases)) {
		const enc = encodeBarcode(mutated, ENCODING_BINARY);
		const canvas = makeCanvas(1, 1);
		enc.qr.drawCanvas(6, 4, canvas);
		const { code } = decodeFrom(canvas);
		const verified = code ? await readAndVerify(code, ISSUER.publicKey) : { ok: false, stage: 'decode' };
		record(`${label} is rejected`, verified.ok === false, `stage: ${verified.stage}`);
	}

	const wrongIssuer = await readAndVerify(flat.code, '8'.repeat(96));
	record('card from an untrusted issuer is rejected', wrongIssuer.ok === false, `stage: ${wrongIssuer.stage}`);

	/* ---------------- summary ---------------- */
	const passed = results.filter(Boolean).length;
	const total = results.length;
	const allPassed = passed === total;
	summaryEl.innerHTML = `
		<div class="verdict verdict--${allPassed ? 'pass' : 'fail'}">
			<div class="verdict__icon">${allPassed ? '✓' : '✕'}</div>
			<div>
				<div class="verdict__title">${passed} of ${total} checks passed</div>
				<div class="verdict__detail">${allPassed
					? 'The full issue-to-verify pipeline works, including skewed capture and forgery detection.'
					: 'Something regressed. Expand the results below.'}</div>
			</div>
		</div>`;
}

document.getElementById('rerun').addEventListener('click', () => {
	run().catch(error => {
		console.error(error);
		resultsEl.innerHTML = `<div class="status-line status-line--error">${error.message}</div>`;
	});
});

run().catch(error => {
	console.error(error);
	resultsEl.innerHTML = `<div class="status-line status-line--error">${error.message}</div>`;
});
