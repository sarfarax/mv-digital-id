'use strict';

import {
	applyCardGeometry,
	canonicalPortrait,
	centreCrop,
	clampCrop,
	CARD,
	PORTRAIT_ASPECT
} from './card.js';
import { pHashHex } from './phash.js';
import {
	FIELD_KEYS,
	validateFields,
	buildMessage,
	signMessage,
	publicKeyFromSecret,
	joinBarcodeData,
	splitBarcodeData,
	parseMessage,
	verifyMessage,
	encodeBarcode,
	chunkHex,
	randomSecretKey,
	TIER_ENHANCED
} from './payload.js';
import { faceCodeFromPixels, faceModelsLoaded } from './facecode.js';
import { ISSUER, DEMO_SECRET_KEY } from './issuer-key.js';

applyCardGeometry();

const $ = id => document.getElementById(id);

const dom = {
	form: $('detailsForm'),
	loadSample: $('loadSample'),

	photoDrop: $('photoDrop'),
	photoInput: $('photoInput'),
	photoPick: $('photoPick'),
	photoDropLabel: $('photoDropLabel'),
	cropperWrap: $('cropperWrap'),
	cropper: $('cropper'),
	cropCanvas: $('cropCanvas'),
	cropFrame: $('cropFrame'),
	cropZoom: $('cropZoom'),
	cropZoomOut: $('cropZoomOut'),
	portraitPreview: $('portraitPreview'),
	photoHashOut: $('photoHashOut'),
	tierInputs: document.querySelectorAll('input[name="tier"]'),
	faceCodeWrap: $('faceCodeWrap'),
	faceCodeOut: $('faceCodeOut'),
	faceCodeStatus: $('faceCodeStatus'),

	secretKey: $('secretKey'),
	publicKey: $('publicKey'),
	publicKeyNote: $('publicKeyNote'),
	newKey: $('newKey'),
	resetKey: $('resetKey'),
	encodingMode: $('encodingMode'),

	generate: $('generate'),
	generateStatus: $('generateStatus'),
	selfVerify: $('selfVerify'),
	selfVerifyResult: $('selfVerifyResult'),

	idCard: $('idCard'),
	cardState: $('cardState'),
	cardPortrait: $('cardPortrait'),
	cardPortraitEmpty: $('cardPortraitEmpty'),
	cardIdNumber: $('cardIdNumber'),
	cardName: $('cardName'),
	cardSex: $('cardSex'),
	cardDob: $('cardDob'),
	cardExpiry: $('cardExpiry'),
	cardAddress: $('cardAddress'),
	cardQr: $('cardQr'),
	cardIssuer: $('cardIssuer'),
	cardTier: $('cardTier'),
	printCard: $('printCard'),
	downloadCard: $('downloadCard'),

	messageOut: $('messageOut'),
	signatureOut: $('signatureOut'),
	barcodeData: $('barcodeData'),
	payloadSize: $('payloadSize'),
	boundTier: $('boundTier'),
	boundHash: $('boundHash'),
	boundFaceCode: $('boundFaceCode'),
	boundQrVersion: $('boundQrVersion'),
	boundEncoding: $('boundEncoding')
};

const state = {
	image: null,       // the uploaded HTMLImageElement
	crop: null,        // crop rectangle in source-image pixels
	portrait: null,    // { imageData, canvas, dataUrl } from canonicalPortrait
	photoHash: null,
	faceCode: null,    // MV3 only; null until a face is found in the current portrait
	faceRun: 0,        // discards face-code results for a portrait that has since changed
	issued: null       // the last successfully signed card
};

// Maldivian ID cards run for ten years. Deriving the sample's expiry from the
// current date rather than hard-coding one keeps the sample issuable forever.
const CARD_VALIDITY_YEARS = 10;

function defaultExpiry(from = new Date()) {
	const date = new Date(Date.UTC(
		from.getUTCFullYear() + CARD_VALIDITY_YEARS,
		from.getUTCMonth(),
		from.getUTCDate()
	));
	return date.toISOString().slice(0, 10);
}

const SAMPLE = {
	idNumber: 'A123456',
	name: 'Aishath Nasheeda Ibrahim',
	sex: 'F',
	dob: '1991-04-17',
	expiry: defaultExpiry(),
	address: 'Ma. Blue Heaven, Male, Maldives'
};

/* ------------------------------------------------------------------ *
 * Form
 * ------------------------------------------------------------------ */

function readFields() {
	const fields = {};
	for (const key of FIELD_KEYS) fields[key] = $(key)?.value ?? '';
	return fields;
}

function showFieldErrors(errors) {
	for (const key of FIELD_KEYS) {
		const wrapper = document.querySelector(`.field[data-field="${key}"]`);
		const slot = document.querySelector(`[data-error-for="${key}"]`);
		if (slot) slot.textContent = errors[key] ?? '';
		if (wrapper) wrapper.classList.toggle('field--invalid', Boolean(errors[key]));
	}
}

dom.loadSample.addEventListener('click', async () => {
	for (const [key, value] of Object.entries(SAMPLE)) {
		const input = $(key);
		if (input) input.value = value;
	}
	showFieldErrors({});
	updateCardPreview();
	invalidateIssued('Details changed. Sign again to refresh the QR code.');

	try {
		await loadSamplePortrait();
		setStatus(dom.generateStatus, 'Sample cardholder and portrait loaded. Press Sign & encode when ready.', null);
	} catch (error) {
		console.warn('Could not load the sample portrait:', error);
		setStatus(dom.generateStatus, 'Sample details loaded, but the portrait could not be fetched. Choose an image manually.', 'error');
	}
});

/**
 * Fetch the bundled sample face and run it through the normal portrait
 * pipeline so "Load sample" needs no separate file picker.
 * Source: Maldives Immigration passport photo standards examples —
 * https://imuga.immigration.gov.mv/passport/photo-standards
 */
async function loadSamplePortrait() {
	const response = await fetch('samples/portrait-2.jpg');
	if (!response.ok) throw new Error(`Sample portrait HTTP ${response.status}`);
	const blob = await response.blob();
	const file = new File([blob], 'portrait-2.jpg', { type: blob.type || 'image/jpeg' });
	loadPhoto(file);
}

dom.form.addEventListener('input', () => {
	updateCardPreview();
	if (state.issued) invalidateIssued('Details changed. Sign again to refresh the QR code.');
});

function formatDate(iso) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '—';
	// Compact VIZ form keeps dates inside the field column beside the QR.
	const [y, m, d] = iso.split('-');
	return `${d}.${m}.${y}`;
}

function updateCardPreview() {
	const fields = readFields();
	dom.cardIdNumber.textContent = fields.idNumber || '—';
	dom.cardName.textContent = fields.name || '—';
	dom.cardSex.textContent = fields.sex || '—';
	dom.cardDob.textContent = formatDate(fields.dob);
	dom.cardExpiry.textContent = formatDate(fields.expiry);
	dom.cardAddress.textContent = fields.address || '—';
}

/* ------------------------------------------------------------------ *
 * Portrait: upload, crop, hash
 * ------------------------------------------------------------------ */

dom.photoPick.addEventListener('click', () => dom.photoInput.click());
dom.photoInput.addEventListener('change', event => {
	const file = event.target.files?.[0];
	if (file) loadPhoto(file);
});

['dragenter', 'dragover'].forEach(type => {
	dom.photoDrop.addEventListener(type, event => {
		event.preventDefault();
		dom.photoDrop.classList.add('is-dragging');
	});
});
['dragleave', 'drop'].forEach(type => {
	dom.photoDrop.addEventListener(type, event => {
		event.preventDefault();
		dom.photoDrop.classList.remove('is-dragging');
	});
});
dom.photoDrop.addEventListener('drop', event => {
	const file = event.dataTransfer?.files?.[0];
	if (file && file.type.startsWith('image/')) loadPhoto(file);
});

function loadPhoto(file) {
	const reader = new FileReader();
	reader.onload = () => {
		const image = new Image();
		image.onload = () => {
			state.image = image;
			state.crop = centreCrop(image.naturalWidth, image.naturalHeight);
			dom.photoDropLabel.textContent = file.name;
			dom.cropperWrap.classList.remove('hidden');
			// Express the starting crop as a zoom percentage of the widest possible frame.
			const maxCrop = centreCrop(image.naturalWidth, image.naturalHeight);
			dom.cropZoom.value = String(Math.round((state.crop.width / maxCrop.width) * 100));
			drawCropper();
			refreshPortrait();
		};
		image.onerror = () => setStatus(dom.generateStatus, 'That file could not be read as an image.', 'error');
		image.src = reader.result;
	};
	reader.readAsDataURL(file);
}

function drawCropper() {
	if (!state.image) return;

	const displayWidth = dom.cropper.clientWidth || 420;
	const scale = displayWidth / state.image.naturalWidth;
	const displayHeight = Math.round(state.image.naturalHeight * scale);

	dom.cropCanvas.width = displayWidth;
	dom.cropCanvas.height = displayHeight;
	const ctx = dom.cropCanvas.getContext('2d');
	ctx.drawImage(state.image, 0, 0, displayWidth, displayHeight);

	dom.cropFrame.style.left = `${state.crop.x * scale}px`;
	dom.cropFrame.style.top = `${state.crop.y * scale}px`;
	dom.cropFrame.style.width = `${state.crop.width * scale}px`;
	dom.cropFrame.style.height = `${state.crop.height * scale}px`;
}

dom.cropZoom.addEventListener('input', () => {
	if (!state.image) return;
	const percent = Number(dom.cropZoom.value);
	dom.cropZoomOut.textContent = `${percent}%`;

	const maxCrop = centreCrop(state.image.naturalWidth, state.image.naturalHeight);
	const width = maxCrop.width * (percent / 100);
	const height = width / PORTRAIT_ASPECT;

	// Zoom around the current centre so the framing does not jump.
	const centreX = state.crop.x + state.crop.width / 2;
	const centreY = state.crop.y + state.crop.height / 2;
	state.crop = clampCrop(
		{ x: centreX - width / 2, y: centreY - height / 2, width, height },
		state.image.naturalWidth,
		state.image.naturalHeight
	);

	drawCropper();
	refreshPortrait();
});

let drag = null;
dom.cropper.addEventListener('pointerdown', event => {
	if (!state.image) return;
	dom.cropper.setPointerCapture(event.pointerId);
	dom.cropper.classList.add('is-dragging');
	drag = { x: event.clientX, y: event.clientY, cropX: state.crop.x, cropY: state.crop.y };
});

dom.cropper.addEventListener('pointermove', event => {
	if (!drag || !state.image) return;
	const scale = dom.cropCanvas.width / state.image.naturalWidth;
	state.crop = clampCrop(
		{
			x: drag.cropX + (event.clientX - drag.x) / scale,
			y: drag.cropY + (event.clientY - drag.y) / scale,
			width: state.crop.width,
			height: state.crop.height
		},
		state.image.naturalWidth,
		state.image.naturalHeight
	);
	drawCropper();
});

function endDrag(event) {
	if (!drag) return;
	drag = null;
	dom.cropper.classList.remove('is-dragging');
	if (event?.pointerId !== undefined && dom.cropper.hasPointerCapture?.(event.pointerId)) {
		dom.cropper.releasePointerCapture(event.pointerId);
	}
	refreshPortrait();
}

dom.cropper.addEventListener('pointerup', endDrag);
dom.cropper.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => {
	if (state.image) drawCropper();
});

function refreshPortrait() {
	if (!state.image || !state.crop) return;

	state.portrait = canonicalPortrait(state.image, state.crop);
	state.photoHash = pHashHex(state.portrait.imageData);

	const ctx = dom.portraitPreview.getContext('2d');
	ctx.putImageData(state.portrait.imageData, 0, 0);

	dom.photoHashOut.textContent = chunkHex(state.photoHash, 4, ' ');
	dom.cardPortrait.src = state.portrait.dataUrl;
	dom.cardPortrait.classList.remove('hidden');
	dom.cardPortraitEmpty.classList.add('hidden');

	if (state.issued) invalidateIssued('Portrait changed. Sign again to refresh the QR code.');
	refreshFaceCode();
}

/* ------------------------------------------------------------------ *
 * Assurance tier and face code
 * ------------------------------------------------------------------ */

function selectedTier() {
	return document.querySelector('input[name="tier"]:checked')?.value ?? 'standard';
}

let faceCodeTimer = null;

/*
 * The zoom slider fires continuously and each embedding takes a few hundred
 * milliseconds, so wait for the framing to settle. The face code is taken from
 * the normalised portrait — the same greyscale image that is printed and
 * hashed — so the signed template describes the photograph on the card.
 */
function refreshFaceCode() {
	state.faceCode = null;
	clearTimeout(faceCodeTimer);
	const run = ++state.faceRun;

	if (selectedTier() !== TIER_ENHANCED) return;
	dom.faceCodeOut.textContent = '—';
	if (!state.portrait) {
		setStatus(dom.faceCodeStatus, 'Add a portrait to compute the face code.', null);
		return;
	}

	setStatus(dom.faceCodeStatus, faceModelsLoaded() ? 'Finding the face…' : 'Loading face models (about 7 MB, once)…', null);
	faceCodeTimer = setTimeout(async () => {
		try {
			const started = performance.now();
			const face = await faceCodeFromPixels(state.portrait.imageData);
			if (run !== state.faceRun) return;
			if (!face) {
				setStatus(dom.faceCodeStatus, 'No face found in the frame. Zoom out or re-centre the portrait.', 'error');
				return;
			}
			state.faceCode = face.code;
			dom.faceCodeOut.textContent = chunkHex(face.code, 4, ' ');
			setStatus(dom.faceCodeStatus,
				`128-bit face code from the framed portrait (detector confidence ${Math.round(face.score * 100)}%, ${Math.round(performance.now() - started)} ms).`, 'ok');
		} catch (error) {
			if (run !== state.faceRun) return;
			console.error(error);
			setStatus(dom.faceCodeStatus, `Face models could not be loaded: ${error.message}`, 'error');
		}
	}, 250);
}

dom.tierInputs.forEach(input => input.addEventListener('change', () => {
	const enhanced = selectedTier() === TIER_ENHANCED;
	dom.faceCodeWrap.classList.toggle('hidden', !enhanced);
	refreshFaceCode();
	if (state.issued) invalidateIssued('Assurance tier changed. Sign again to refresh the QR code.');
}));

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

function setSecretKey(hex) {
	dom.secretKey.value = hex;
	refreshPublicKey();
}

function refreshPublicKey() {
	const slot = document.querySelector('[data-error-for="secretKey"]');
	const secret = dom.secretKey.value.replace(/\s+/g, '');

	if (!/^[0-9a-fA-F]{64}$/.test(secret)) {
		dom.publicKey.value = '';
		dom.publicKeyNote.textContent = '';
		slot.textContent = 'Expected 64 hexadecimal characters.';
		return null;
	}

	try {
		const publicKey = publicKeyFromSecret(secret);
		dom.publicKey.value = publicKey;
		slot.textContent = '';
		dom.publicKeyNote.textContent = publicKey === ISSUER.publicKey
			? 'Matches the key built into the scanner, so cards signed here will verify there.'
			: 'This is not the key the scanner trusts. Paste it into the scanner to verify these cards.';
		return publicKey;
	} catch (error) {
		dom.publicKey.value = '';
		slot.textContent = `Invalid key: ${error.message}`;
		return null;
	}
}

dom.secretKey.addEventListener('input', () => {
	refreshPublicKey();
	if (state.issued) invalidateIssued('Signing key changed. Sign again to refresh the QR code.');
});

dom.newKey.addEventListener('click', () => {
	setSecretKey(randomSecretKey());
	invalidateIssued('New keypair generated. Sign again to refresh the QR code.');
});

dom.resetKey.addEventListener('click', () => {
	setSecretKey(DEMO_SECRET_KEY);
	invalidateIssued('Demo key restored. Sign again to refresh the QR code.');
});

dom.encodingMode.addEventListener('change', () => {
	if (state.issued) invalidateIssued('Encoding changed. Sign again to refresh the QR code.');
});

/* ------------------------------------------------------------------ *
 * Signing and rendering
 * ------------------------------------------------------------------ */

function setStatus(element, text, kind) {
	element.textContent = text;
	element.className = 'status-line' + (kind ? ` status-line--${kind}` : '');
}

function invalidateIssued(reason) {
	state.issued = null;
	// Not "out of date", which now means an expired card rather than a stale QR.
	dom.cardState.textContent = 'Needs re-signing';
	dom.cardState.className = 'badge badge--warn';
	dom.idCard.classList.add('id-card--placeholder');
	dom.selfVerify.disabled = true;
	dom.printCard.disabled = true;
	dom.downloadCard.disabled = true;
	dom.selfVerifyResult.innerHTML = '';
	if (reason) setStatus(dom.generateStatus, reason, null);
}

function drawQr(qr) {
	// Border 0: the mandatory quiet zone is supplied by the white card stock
	// behind the canvas, so the symbol occupies exactly QR_RECT. The scanner's
	// homography depends on that being true.
	const modulePixels = 8;
	qr.drawCanvas(modulePixels, 0, dom.cardQr);
}

dom.generate.addEventListener('click', async () => {
	const { clean, errors, valid } = validateFields(readFields());
	showFieldErrors(errors);

	if (!valid) {
		setStatus(dom.generateStatus, 'Fix the highlighted fields first.', 'error');
		return;
	}
	if (!state.photoHash) {
		setStatus(dom.generateStatus, 'Add a portrait before signing.', 'error');
		return;
	}
	const enhanced = selectedTier() === TIER_ENHANCED;
	if (enhanced && !state.faceCode) {
		setStatus(dom.generateStatus, 'Enhanced cards need a face code. Wait for it to finish, or adjust the portrait until a face is found.', 'error');
		return;
	}

	const secret = dom.secretKey.value.replace(/\s+/g, '');
	const publicKey = refreshPublicKey();
	if (!publicKey) {
		setStatus(dom.generateStatus, 'The signing key is not valid.', 'error');
		return;
	}

	dom.generate.disabled = true;
	setStatus(dom.generateStatus, 'Signing…', null);

	try {
		// Yield once so the button's disabled state paints before the curve
		// arithmetic blocks the main thread.
		await new Promise(resolve => setTimeout(resolve, 0));

		const faceCode = enhanced ? state.faceCode : null;
		const message = buildMessage(clean, state.photoHash, faceCode);
		const signature = await signMessage(message, secret);
		const barcodeData = joinBarcodeData(message, signature);
		const encoded = encodeBarcode(barcodeData, dom.encodingMode.value);

		drawQr(encoded.qr);

		state.issued = { message, signature, barcodeData, encoded, publicKey, fields: clean, faceCode };

		dom.messageOut.textContent = message;
		dom.signatureOut.textContent = chunkHex(signature, 8, ' ');
		dom.barcodeData.value = barcodeData;
		dom.payloadSize.textContent = `${encoded.byteLength} bytes`;
		dom.payloadSize.className = 'badge';
		dom.boundTier.textContent = enhanced ? 'Enhanced (MV3)' : 'Standard (MV2)';
		dom.boundHash.textContent = state.photoHash;
		dom.boundFaceCode.textContent = faceCode ?? 'None — Standard tier';
		dom.boundQrVersion.textContent = `${encoded.qr.version} (${encoded.qr.size}×${encoded.qr.size} modules)`;
		dom.boundEncoding.textContent = encoded.mode === 'text' ? 'URL-safe text' : 'Binary byte mode';
		dom.cardIssuer.textContent = ISSUER.name;
		dom.cardTier.textContent = enhanced ? 'Enhanced · BLS12-381 signed' : 'BLS12-381 signed';

		dom.idCard.classList.remove('id-card--placeholder');
		dom.cardState.textContent = 'Signed';
		dom.cardState.className = 'badge badge--ok';
		dom.selfVerify.disabled = false;
		dom.printCard.disabled = false;
		dom.downloadCard.disabled = false;
		dom.selfVerifyResult.innerHTML = '';

		setStatus(dom.generateStatus, 'Card signed. Print it, or scan it with the verifier.', 'ok');
	} catch (error) {
		console.error(error);
		setStatus(dom.generateStatus, `Signing failed: ${error.message}`, 'error');
	} finally {
		dom.generate.disabled = false;
	}
});

/* ------------------------------------------------------------------ *
 * Self-verification, including deliberate tampering
 * ------------------------------------------------------------------ */

function renderVerdict(target, kind, title, detail) {
	const icons = { pass: '✓', fail: '✕', warn: '!' };
	target.innerHTML = `
		<div class="verdict verdict--${kind}">
			<div class="verdict__icon">${icons[kind] ?? '?'}</div>
			<div>
				<div class="verdict__title">${title}</div>
				<div class="verdict__detail">${detail}</div>
			</div>
		</div>`;
}

dom.selfVerify.addEventListener('click', async () => {
	const publicKey = dom.publicKey.value.replace(/\s+/g, '');
	const { message, signature } = splitBarcodeData(dom.barcodeData.value.trim());

	if (!signature) {
		renderVerdict(dom.selfVerifyResult, 'fail', 'Nothing to verify', 'The barcode data has no signature attached.');
		return;
	}

	try {
		parseMessage(message);
	} catch (error) {
		renderVerdict(dom.selfVerifyResult, 'fail', 'Malformed payload', error.message);
		return;
	}

	dom.selfVerify.disabled = true;
	const verified = await verifyMessage(message, signature, publicKey);
	dom.selfVerify.disabled = false;

	const tampered = state.issued && dom.barcodeData.value.trim() !== state.issued.barcodeData;

	if (verified) {
		renderVerdict(dom.selfVerifyResult, 'pass', 'Signature valid',
			'The payload is unmodified and was signed by the key above.');
	} else {
		renderVerdict(dom.selfVerifyResult, 'fail', 'Signature rejected',
			tampered
				? 'The barcode data was edited after signing, so the signature no longer matches.'
				: 'The signature does not match this message and public key.');
	}
});

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

dom.printCard.addEventListener('click', () => window.print());

dom.downloadCard.addEventListener('click', async () => {
	if (!state.issued) return;
	dom.downloadCard.disabled = true;
	try {
		const blob = await renderCardToPng();
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = `id-card-${state.issued.fields.idNumber || 'card'}.png`;
		link.click();
		URL.revokeObjectURL(url);
	} catch (error) {
		console.error(error);
		setStatus(dom.generateStatus, `Could not render the card: ${error.message}`, 'error');
	} finally {
		dom.downloadCard.disabled = false;
	}
});

/*
 * Rasterise the card by drawing it into an SVG <foreignObject>. This keeps the
 * PNG in step with the CSS layout automatically, so the download and the print
 * output cannot drift apart.
 */
async function renderCardToPng(dpi = 600) {
	const mmToPx = dpi / 25.4;
	const width = Math.round(CARD.width * mmToPx);
	const height = Math.round(CARD.height * mmToPx);

	// Inside foreignObject the card is laid out in CSS pixels, so the viewBox has
	// to be the card's size in CSS pixels (1mm = 96/25.4px) rather than in
	// millimetres. Getting this wrong scales the content against its frame.
	const cssPxPerMm = 96 / 25.4;
	const viewWidth = CARD.width * cssPxPerMm;
	const viewHeight = CARD.height * cssPxPerMm;

	const styleText = await fetch('css/style.css').then(response => response.text());
	const clone = dom.idCard.cloneNode(true);
	clone.classList.remove('id-card--placeholder');
	clone.style.transform = 'none';

	// Inline the QR canvas; a cloned canvas is blank.
	const qrImage = document.createElement('img');
	qrImage.setAttribute('class', 'id-card__qr');
	qrImage.setAttribute('src', dom.cardQr.toDataURL('image/png'));
	clone.querySelector('.id-card__qr').replaceWith(qrImage);

	const geometry = document.documentElement.getAttribute('style') ?? '';

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${viewWidth} ${viewHeight}">
		<foreignObject width="100%" height="100%">
			<div xmlns="http://www.w3.org/1999/xhtml" style="${geometry}">
				<style>${styleText}</style>
				${new XMLSerializer().serializeToString(clone)}
			</div>
		</foreignObject>
	</svg>`;

	const image = new Image();
	image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
	await image.decode();

	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, width, height);
	ctx.drawImage(image, 0, 0, width, height);

	return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

setSecretKey(DEMO_SECRET_KEY);
dom.cardIssuer.textContent = ISSUER.name;
updateCardPreview();
setStatus(dom.generateStatus, 'Load the sample cardholder to try it quickly.', null);
