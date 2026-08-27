'use strict';

import {
	applyCardGeometry,
	canonicalPortrait,
	centreCrop,
	frameToImageData,
	portraitFromCardPhoto,
	homography,
	applyHomography,
	rectCorners,
	PORTRAIT_RECT,
	QR_RECT
} from './card.js';
import { pHashHex, hammingDistance, HASH_BITS } from './phash.js';
import { readAndVerify, chunkHex, expiryStatus } from './payload.js';
import { ISSUER } from './issuer-key.js';

applyCardGeometry();

const $ = id => document.getElementById(id);

// Detection resolution. Large enough that the portrait region lands near its
// canonical 300px width, small enough to decode at video frame rate.
const MAX_SCAN_WIDTH = 1280;

// A card this close to expiry still passes, but an operator should be told.
const EXPIRY_WARNING_DAYS = 90;

const dom = {
	overallVerdict: $('overallVerdict'),

	video: $('video'),
	overlay: $('overlay'),
	cameraIdle: $('cameraIdle'),
	cameraHint: $('cameraHint'),
	startCamera: $('startCamera'),
	stopCamera: $('stopCamera'),
	scanStatus: $('scanStatus'),
	signatureBadge: $('signatureBadge'),

	cardDrop: $('cardDrop'),
	cardInput: $('cardInput'),
	cardPick: $('cardPick'),
	cardDropLabel: $('cardDropLabel'),
	cardImageWrap: $('cardImageWrap'),
	cardImagePreview: $('cardImagePreview'),

	photoBadge: $('photoBadge'),
	capturedPortrait: $('capturedPortrait'),
	distanceValue: $('distanceValue'),
	distanceMeter: $('distanceMeter'),
	distanceNote: $('distanceNote'),
	expectedHash: $('expectedHash'),
	measuredHash: $('measuredHash'),
	threshold: $('threshold'),
	thresholdOut: $('thresholdOut'),
	photoStatus: $('photoStatus'),

	photoCardInput: $('photoCardInput'),
	photoCardPick: $('photoCardPick'),
	photoCardDrop: $('photoCardDrop'),
	photoDirectInput: $('photoDirectInput'),
	photoDirectPick: $('photoDirectPick'),
	photoDirectDrop: $('photoDirectDrop'),

	trustedKey: $('trustedKey'),
	trustedKeyNote: $('trustedKeyNote'),
	restoreKey: $('restoreKey'),

	identityNote: $('identityNote'),
	rawMessage: $('rawMessage'),
	rawSignature: $('rawSignature'),
	payloadBadge: $('payloadBadge')
};

const state = {
	stream: null,
	scanning: false,
	rafId: null,
	verification: null,   // the last readAndVerify result
	measuredHash: null,
	busy: false,
	lastPayload: null     // guards against re-verifying the same code every frame
};

const scanCanvas = document.createElement('canvas');
const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function setStatus(element, text, kind) {
	element.textContent = text;
	element.className = 'status-line' + (kind ? ` status-line--${kind}` : '');
}

function setBadge(element, text, kind) {
	element.textContent = text;
	element.className = 'badge' + (kind ? ` badge--${kind}` : '');
}

function formatDate(iso) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return iso || '—';
	const [y, m, d] = iso.split('-');
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${d} ${months[Number(m) - 1] ?? m} ${y}`;
}

function readImageFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('That file could not be read as an image.'));
			image.src = reader.result;
		};
		reader.onerror = () => reject(new Error('That file could not be read.'));
		reader.readAsDataURL(file);
	});
}

function wireDropZone(zone, input, onFile) {
	['dragenter', 'dragover'].forEach(type => zone.addEventListener(type, event => {
		event.preventDefault();
		zone.classList.add('is-dragging');
	}));
	['dragleave', 'drop'].forEach(type => zone.addEventListener(type, event => {
		event.preventDefault();
		zone.classList.remove('is-dragging');
	}));
	zone.addEventListener('drop', event => {
		const file = event.dataTransfer?.files?.[0];
		if (file?.type.startsWith('image/')) onFile(file);
	});
	input.addEventListener('change', event => {
		const file = event.target.files?.[0];
		if (file) onFile(file);
	});
}

/** Scale an image down to MAX_SCAN_WIDTH and return its pixels. */
function imageToScanData(image) {
	const naturalWidth = image.naturalWidth ?? image.videoWidth ?? image.width;
	const naturalHeight = image.naturalHeight ?? image.videoHeight ?? image.height;
	const scale = Math.min(1, MAX_SCAN_WIDTH / naturalWidth);
	const width = Math.max(1, Math.round(naturalWidth * scale));
	const height = Math.max(1, Math.round(naturalHeight * scale));
	return frameToImageData(image, width, height);
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

document.querySelectorAll('[role="tab"]').forEach(tab => {
	tab.addEventListener('click', () => {
		const group = tab.dataset.tab;
		document.querySelectorAll(`[role="tab"][data-tab="${group}"]`).forEach(other => {
			const selected = other === tab;
			other.setAttribute('aria-selected', String(selected));
			$(other.dataset.panel).classList.toggle('hidden', !selected);
		});
		if (group === 'qr' && tab.dataset.panel !== 'qrCamera') stopCamera();
	});
});

/* ------------------------------------------------------------------ *
 * Trusted key
 * ------------------------------------------------------------------ */

function trustedKey() {
	return dom.trustedKey.value.replace(/\s+/g, '');
}

function refreshTrustedKeyNote() {
	const key = trustedKey();
	if (key === ISSUER.publicKey) {
		dom.trustedKeyNote.textContent = `Official key for the ${ISSUER.name}.`;
	} else if (/^[0-9a-fA-F]{96}$/.test(key)) {
		dom.trustedKeyNote.textContent = 'Custom key. Only cards signed with the matching secret key will verify.';
	} else {
		dom.trustedKeyNote.textContent = 'A BLS12-381 public key is 96 hexadecimal characters.';
	}
}

dom.trustedKey.addEventListener('input', () => {
	refreshTrustedKeyNote();
	// A different trust anchor means the last card deserves a fresh judgement.
	state.lastPayload = null;
});

dom.restoreKey.addEventListener('click', () => {
	dom.trustedKey.value = ISSUER.publicKey;
	state.lastPayload = null;
	refreshTrustedKeyNote();
});

/* ------------------------------------------------------------------ *
 * Verdicts
 * ------------------------------------------------------------------ */

function renderOverallVerdict() {
	const signature = state.verification;
	const hasSignature = Boolean(signature);
	const signatureOk = signature?.ok === true;

	const expected = signature?.photoHash;
	const measured = state.measuredHash;
	const hasPhoto = Boolean(expected && measured);
	const distance = hasPhoto ? hammingDistance(expected, measured) : null;
	const photoOk = hasPhoto ? distance <= Number(dom.threshold.value) : null;

	let kind;
	let title;
	let detail;

	if (!hasSignature) {
		dom.overallVerdict.innerHTML = '';
		return;
	}

	const expiry = signatureOk ? expiryStatus(signature.fields?.expiry) : null;

	if (!signatureOk) {
		kind = 'fail';
		title = 'Card rejected';
		detail = signature.error ?? 'The signature check failed.';
	} else if (expiry.state === 'expired') {
		/*
		 * Deliberately ranked above the portrait check. A signature only ever
		 * says "this was issued"; an expired card is genuine and unusable at the
		 * same time, and matching the photograph does not change that.
		 */
		kind = 'fail';
		title = 'Card expired';
		detail = `The signature is authentic, but the card expired on ${formatDate(signature.fields.expiry)}. It is no longer valid identification.`;
	} else if (expiry.state === 'unreadable') {
		kind = 'fail';
		title = 'Card rejected';
		detail = 'The signature is authentic, but the expiry date is not a readable calendar date, so the card cannot be accepted.';
	} else if (!hasPhoto) {
		kind = 'warn';
		title = 'Signature valid, portrait not yet checked';
		detail = 'The printed details are authentic and the card is in date. Capture the portrait to confirm the photograph was not swapped.';
	} else if (photoOk) {
		kind = 'pass';
		title = 'Card verified';
		detail = `The details are authentic and the portrait matches the signed hash (${distance} of ${HASH_BITS} bits differ).`;
		if (expiry.daysRemaining <= EXPIRY_WARNING_DAYS) {
			kind = 'warn';
			detail += ` The card is still valid but expires in ${expiry.daysRemaining} day${expiry.daysRemaining === 1 ? '' : 's'}.`;
		}
	} else {
		kind = 'fail';
		title = 'Portrait does not match';
		detail = `The signature is valid, but the photograph differs from the one the authority signed (${distance} of ${HASH_BITS} bits differ). The card may have been re-photographed or the portrait replaced.`;
	}

	const icons = { pass: '✓', fail: '✕', warn: '!' };
	dom.overallVerdict.innerHTML = `
		<div class="verdict verdict--${kind}">
			<div class="verdict__icon">${icons[kind]}</div>
			<div>
				<div class="verdict__title">${title}</div>
				<div class="verdict__detail">${detail}</div>
			</div>
		</div>`;
}

function renderIdentity(result) {
	const fields = result?.fields ?? {};
	$('outIdNumber').textContent = fields.idNumber || '—';
	$('outName').textContent = fields.name || '—';
	$('outSex').textContent = fields.sex || '—';
	$('outDob').textContent = formatDate(fields.dob);
	$('outExpiry').textContent = formatDate(fields.expiry);
	$('outAddress').textContent = fields.address || '—';

	if (!result) {
		dom.identityNote.textContent = 'Nothing scanned yet. These values are only trustworthy once the signature check passes.';
		dom.identityNote.className = 'note';
	} else if (result.ok) {
		dom.identityNote.textContent = `Signed by the ${ISSUER.name} and unmodified since issue.`;
		dom.identityNote.className = 'note';
	} else {
		dom.identityNote.textContent = 'The signature failed, so these values prove nothing. They are shown only for diagnosis.';
		dom.identityNote.className = 'note note--warn';
	}
}

function resetPhotoResult() {
	state.measuredHash = null;
	dom.capturedPortrait.getContext('2d').clearRect(0, 0, 300, 400);
	dom.distanceValue.textContent = '—';
	dom.distanceMeter.style.width = '0';
	dom.measuredHash.textContent = '—';
	setBadge(dom.photoBadge, 'Waiting', null);
}

/* ------------------------------------------------------------------ *
 * Step 1: decode and verify
 * ------------------------------------------------------------------ */

function payloadKey(code) {
	return code.binaryData?.length ? Array.from(code.binaryData).join(',') : code.data;
}

async function handleDecodedCode(code, imageData, source, { force = false } = {}) {
	if (state.busy) return false;

	/*
	 * A camera hands back the same code thirty times a second. Verifying a BLS
	 * signature is expensive enough to stall the scan loop, so a code that has
	 * already been judged is not judged again.
	 */
	const key = payloadKey(code);
	if (!force && key === state.lastPayload) return state.verification?.ok === true;
	state.lastPayload = key;

	state.busy = true;

	try {
		const result = await readAndVerify(code, trustedKey());
		state.verification = result;

		renderIdentity(result);
		dom.rawMessage.textContent = result.message ?? result.error ?? '—';
		dom.rawSignature.textContent = result.signature ? chunkHex(result.signature, 8, ' ') : '—';
		dom.expectedHash.textContent = result.photoHash ? chunkHex(result.photoHash, 4, ' ') : '—';

		if (result.mode) setBadge(dom.payloadBadge, result.mode === 'text' ? 'URL-safe text' : 'Binary byte mode', null);

		if (result.ok) {
			setBadge(dom.signatureBadge, 'Signature valid', 'ok');
			setStatus(dom.scanStatus, `Read from ${source}. Signature verified against the trusted key.`, 'ok');
		} else {
			setBadge(dom.signatureBadge, result.stage === 'decode' ? 'Not an ID card' : 'Signature invalid', 'fail');
			setStatus(dom.scanStatus, result.error, 'error');
		}

		// The same image usually contains the whole card, so try the portrait now.
		resetPhotoResult();
		if (result.photoHash) {
			const portrait = portraitFromCardPhoto(imageData, code.location);
			if (portrait) {
				applyPortrait(portrait, 'the same image');
			} else {
				setStatus(dom.photoStatus, 'The QR was readable but the portrait area fell outside the image. Capture the whole card, or use one of the options below.', null);
			}
		}

		renderOverallVerdict();
		return result.ok;
	} finally {
		state.busy = false;
	}
}

function applyPortrait(portrait, sourceLabel) {
	state.measuredHash = pHashHex(portrait.imageData);
	dom.capturedPortrait.getContext('2d').putImageData(portrait.imageData, 0, 0);
	dom.measuredHash.textContent = chunkHex(state.measuredHash, 4, ' ');

	const expected = state.verification?.photoHash;
	if (!expected) {
		setStatus(dom.photoStatus, 'Portrait captured. Scan the QR code to get the hash to compare it against.', null);
		setBadge(dom.photoBadge, 'No card scanned', 'warn');
		return;
	}

	const distance = hammingDistance(expected, state.measuredHash);
	const limit = Number(dom.threshold.value);
	const pass = distance <= limit;

	dom.distanceValue.textContent = `${distance} / ${HASH_BITS}`;
	dom.distanceMeter.style.width = `${(distance / HASH_BITS) * 100}%`;
	dom.distanceMeter.className = 'meter__fill' + (pass ? '' : ' meter__fill--fail');
	dom.distanceNote.textContent = pass
		? `Within the ${limit}-bit tolerance.`
		: `Above the ${limit}-bit tolerance.`;

	setBadge(dom.photoBadge, pass ? 'Portrait matches' : 'Portrait differs', pass ? 'ok' : 'fail');
	setStatus(dom.photoStatus, `Portrait read from ${sourceLabel}.`, pass ? 'ok' : 'error');
	renderOverallVerdict();
}

dom.threshold.addEventListener('input', () => {
	dom.thresholdOut.textContent = `${dom.threshold.value} bits`;
	if (state.measuredHash && state.verification?.photoHash) {
		const distance = hammingDistance(state.verification.photoHash, state.measuredHash);
		const pass = distance <= Number(dom.threshold.value);
		dom.distanceMeter.className = 'meter__fill' + (pass ? '' : ' meter__fill--fail');
		dom.distanceNote.textContent = pass
			? `Within the ${dom.threshold.value}-bit tolerance.`
			: `Above the ${dom.threshold.value}-bit tolerance.`;
		setBadge(dom.photoBadge, pass ? 'Portrait matches' : 'Portrait differs', pass ? 'ok' : 'fail');
	}
	renderOverallVerdict();
});

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */

async function startCamera() {
	if (!navigator.mediaDevices?.getUserMedia) {
		setStatus(dom.scanStatus, 'This browser does not expose a camera. Use the upload tab instead.', 'error');
		return;
	}

	try {
		state.stream = await navigator.mediaDevices.getUserMedia({
			video: {
				facingMode: { ideal: 'environment' },
				width: { ideal: 1920 },
				height: { ideal: 1080 }
			},
			audio: false
		});
	} catch (error) {
		const reason = error.name === 'NotAllowedError'
			? 'Camera permission was denied.'
			: `The camera could not be opened (${error.name}).`;
		setStatus(dom.scanStatus, `${reason} Use the upload tab instead.`, 'error');
		return;
	}

	dom.video.srcObject = state.stream;
	await dom.video.play();

	dom.cameraIdle.classList.add('hidden');
	dom.startCamera.disabled = true;
	dom.stopCamera.disabled = false;
	state.scanning = true;
	setStatus(dom.scanStatus, 'Scanning…', null);
	tick();
}

function stopCamera() {
	state.scanning = false;
	if (state.rafId) cancelAnimationFrame(state.rafId);
	state.rafId = null;

	if (state.stream) {
		state.stream.getTracks().forEach(track => track.stop());
		state.stream = null;
	}
	dom.video.srcObject = null;
	dom.cameraIdle.classList.remove('hidden');
	dom.startCamera.disabled = false;
	dom.stopCamera.disabled = true;
	clearOverlay();
}

dom.startCamera.addEventListener('click', startCamera);
dom.stopCamera.addEventListener('click', () => {
	stopCamera();
	setStatus(dom.scanStatus, 'Camera stopped.', null);
});

function clearOverlay() {
	const ctx = dom.overlay.getContext('2d');
	ctx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);
}

/*
 * Outline what the scanner found: the QR symbol itself, and where the card's
 * geometry says the portrait must be. Seeing the red box land on the photo is
 * the quickest way to tell that the homography is working.
 */
function drawDetection(ctx, code, { scale = 1, offsetX = 0, offsetY = 0, lineWidth = 2 } = {}) {
	const point = p => ({ x: p.x * scale + offsetX, y: p.y * scale + offsetY });
	const quad = [
		point(code.location.topLeftCorner),
		point(code.location.topRightCorner),
		point(code.location.bottomRightCorner),
		point(code.location.bottomLeftCorner)
	];

	const stroke = (points, colour) => {
		ctx.beginPath();
		points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
		ctx.closePath();
		ctx.strokeStyle = colour;
		ctx.lineWidth = lineWidth;
		ctx.stroke();
	};

	stroke(quad, '#3b7dd8');

	const h = homography(rectCorners(QR_RECT), [
		code.location.topLeftCorner,
		code.location.topRightCorner,
		code.location.bottomRightCorner,
		code.location.bottomLeftCorner
	]);
	if (!h) return;

	const projected = rectCorners(PORTRAIT_RECT)
		.map(corner => applyHomography(h, corner.x, corner.y))
		.filter(Boolean)
		.map(point);
	if (projected.length === 4) stroke(projected, '#ff5a4d');
}

function tick() {
	if (!state.scanning) return;

	const { videoWidth, videoHeight } = dom.video;
	if (!videoWidth || !videoHeight) {
		state.rafId = requestAnimationFrame(tick);
		return;
	}

	const scale = Math.min(1, MAX_SCAN_WIDTH / videoWidth);
	const width = Math.round(videoWidth * scale);
	const height = Math.round(videoHeight * scale);

	scanCanvas.width = width;
	scanCanvas.height = height;
	scanCtx.drawImage(dom.video, 0, 0, width, height);
	const imageData = scanCtx.getImageData(0, 0, width, height);

	const code = window.jsQR(imageData.data, width, height, { inversionAttempts: 'dontInvert' });

	// The overlay is drawn in the video element's displayed coordinate space.
	const rect = dom.video.getBoundingClientRect();
	if (dom.overlay.width !== Math.round(rect.width) || dom.overlay.height !== Math.round(rect.height)) {
		dom.overlay.width = Math.round(rect.width);
		dom.overlay.height = Math.round(rect.height);
	}
	const ctx = dom.overlay.getContext('2d');
	ctx.clearRect(0, 0, dom.overlay.width, dom.overlay.height);

	if (code) {
		// The video is object-fit: cover, so replicate that mapping for the overlay.
		const coverScale = Math.max(dom.overlay.width / width, dom.overlay.height / height);
		drawDetection(ctx, code, {
			scale: coverScale,
			offsetX: (dom.overlay.width - width * coverScale) / 2,
			offsetY: (dom.overlay.height - height * coverScale) / 2,
			lineWidth: 3
		});

		dom.cameraHint.textContent = 'Card detected, verifying…';
		handleDecodedCode(code, imageData, 'the camera').then(ok => {
			if (ok) {
				stopCamera();
				dom.cameraHint.textContent = 'Point the camera at the card';
			}
		});
	} else {
		dom.cameraHint.textContent = 'Point the camera at the card';
	}

	state.rafId = requestAnimationFrame(tick);
}

/* ------------------------------------------------------------------ *
 * Upload paths
 * ------------------------------------------------------------------ */

async function scanCardImage(file, { previewInto } = {}) {
	let image;
	try {
		image = await readImageFile(file);
	} catch (error) {
		setStatus(dom.scanStatus, error.message, 'error');
		return;
	}

	const imageData = imageToScanData(image);
	const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

	if (previewInto) {
		previewInto.width = imageData.width;
		previewInto.height = imageData.height;
		const ctx = previewInto.getContext('2d');
		ctx.putImageData(imageData, 0, 0);
		// The preview canvas keeps the image's own resolution but is displayed a
		// few times smaller, so the outlines have to be drawn proportionally thick
		// to survive being scaled down by CSS.
		if (code) drawDetection(ctx, code, { lineWidth: Math.max(2, imageData.width / 160) });
		dom.cardImageWrap.classList.remove('hidden');
	}

	if (!code) {
		setStatus(dom.scanStatus, 'No QR code was found in that image. Make sure the whole card is visible and in focus.', 'error');
		setBadge(dom.signatureBadge, 'No code found', 'fail');
		return;
	}

	await handleDecodedCode(code, imageData, file.name, { force: true });
}

wireDropZone(dom.cardDrop, dom.cardInput, file => {
	dom.cardDropLabel.textContent = file.name;
	scanCardImage(file, { previewInto: dom.cardImagePreview });
});
dom.cardPick.addEventListener('click', () => dom.cardInput.click());

// Step 2, "photo of the card": re-run detection purely to lift the portrait out.
async function checkPortraitFromCard(file) {
	let image;
	try {
		image = await readImageFile(file);
	} catch (error) {
		setStatus(dom.photoStatus, error.message, 'error');
		return;
	}

	const imageData = imageToScanData(image);
	const code = window.jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'attemptBoth' });

	if (!code) {
		setStatus(dom.photoStatus, 'No QR code was found, so the portrait area could not be located. Use the portrait-only tab if you have just the photograph.', 'error');
		return;
	}

	const portrait = portraitFromCardPhoto(imageData, code.location);
	if (!portrait) {
		setStatus(dom.photoStatus, 'The QR was found but the portrait area fell outside the image. Capture the whole card.', 'error');
		return;
	}

	applyPortrait(portrait, file.name);
}

wireDropZone(dom.photoCardDrop, dom.photoCardInput, checkPortraitFromCard);
dom.photoCardPick.addEventListener('click', () => dom.photoCardInput.click());

// Step 2, "portrait image only": no card geometry involved.
async function checkPortraitDirect(file) {
	let image;
	try {
		image = await readImageFile(file);
	} catch (error) {
		setStatus(dom.photoStatus, error.message, 'error');
		return;
	}

	const crop = centreCrop(image.naturalWidth, image.naturalHeight);
	applyPortrait(canonicalPortrait(image, crop), file.name);
}

wireDropZone(dom.photoDirectDrop, dom.photoDirectInput, checkPortraitDirect);
dom.photoDirectPick.addEventListener('click', () => dom.photoDirectInput.click());

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

dom.trustedKey.value = ISSUER.publicKey;
refreshTrustedKeyNote();
renderIdentity(null);
setStatus(dom.scanStatus, 'Start the camera, or upload a photo of a card.', null);
setStatus(dom.photoStatus, 'Runs automatically once a whole card is scanned.', null);

window.addEventListener('pagehide', stopCamera);
