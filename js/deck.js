'use strict';

/*
 * Presentation shell.
 *
 * Slides live on a fixed 1280x720 stage so a slide looks identical on a
 * laptop, a projector and a printed PDF. The stage is scaled to whatever
 * viewport it finds rather than the layout reflowing, which is what keeps
 * a rehearsed slide from rearranging itself in the room.
 *
 * On a phone that same stage would shrink body text to a few pixels, so
 * small screens get a reader mode instead: every slide reflowed as a card
 * in one scrolling page. "Present slides" switches back to the stage, with
 * swipe and on-screen buttons for navigation.
 */

const stage = document.getElementById('stage');
const progress = document.getElementById('progress');
const slides = Array.from(document.querySelectorAll('.slide'));
const root = document.documentElement;

const controls = {
	present: document.getElementById('presentDeck'),
	exit: document.getElementById('deckExit'),
	prev: document.getElementById('deckPrev'),
	next: document.getElementById('deckNext'),
	position: document.getElementById('deckPos'),
	count: document.getElementById('deckCount')
};

const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;
const MARGIN = 0.94; // breathing room so the stage never touches the screen edge
const SWIPE_DISTANCE = 50; // px of horizontal travel before a touch counts as a swipe

// Keep in step with the inline script in deck.html, which applies it before first paint.
const READER_QUERY = window.matchMedia('(max-width: 760px), (max-height: 500px)');

let current = 0;
let chosenMode = null; // 'reader' | 'slides' once the viewer has picked; null follows the viewport

const isReader = () => root.classList.contains('deck-reader');

/* ------------------------------------------------------------------ *
 * Scaling
 * ------------------------------------------------------------------ */

function fitStage() {
	// Printing lays the slides out as real pages, so the transform must not apply.
	if (window.matchMedia('print').matches) return;
	if (isReader()) {
		stage.style.transform = 'none';
		return;
	}
	// On touch screens the control bar sits below the slide rather than over it.
	const bar = controls.exit.parentElement;
	const reserve = bar.offsetHeight ? bar.offsetHeight + 12 : 0;
	const scale = Math.min(
		(window.innerWidth * MARGIN) / STAGE_WIDTH,
		((window.innerHeight - reserve) * MARGIN) / STAGE_HEIGHT
	);
	stage.style.transform = `translateY(${-reserve / 2}px) scale(${scale})`;
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function setHash() {
	// Reflected in the URL so a specific slide can be linked or reloaded into.
	const hash = `#${current + 1}`;
	if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

function show(index) {
	current = Math.max(0, Math.min(slides.length - 1, index));

	slides.forEach((slide, i) => {
		if (i === current) slide.setAttribute('data-active', '');
		else slide.removeAttribute('data-active');
	});

	progress.style.width = `${((current + 1) / slides.length) * 100}%`;
	controls.position.textContent = `${current + 1} / ${slides.length}`;
	controls.prev.disabled = current === 0;
	controls.next.disabled = current === slides.length - 1;
	setHash();
}

function next() { show(current + 1); }
function previous() { show(current - 1); }

function slideFromHash() {
	const parsed = Number.parseInt(window.location.hash.slice(1), 10);
	return Number.isFinite(parsed) ? parsed - 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Modes
 * ------------------------------------------------------------------ */

function applyMode() {
	const reader = chosenMode ? chosenMode === 'reader' : READER_QUERY.matches;
	const changed = reader !== isReader();
	root.classList.toggle('deck-reader', reader);
	fitStage();
	if (reader && changed) slides[current].scrollIntoView({ block: 'start' });
	if (!reader) show(current);
}

function present() {
	chosenMode = 'slides';
	applyMode();
	// Both are best effort: iPhone Safari has no element fullscreen, and
	// orientation lock only works inside fullscreen on Android.
	if (!document.documentElement.requestFullscreen) return;
	document.documentElement.requestFullscreen()
		.then(() => screen.orientation?.lock?.('landscape'))
		.catch(() => {});
}

function readAsPage() {
	chosenMode = 'reader';
	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	applyMode();
}

controls.present.addEventListener('click', present);
controls.exit.addEventListener('click', readAsPage);
controls.prev.addEventListener('click', previous);
controls.next.addEventListener('click', next);
READER_QUERY.addEventListener('change', applyMode);

// In reader mode the slide nearest the top of the screen is the current one,
// so the URL and "Present slides" both pick up where the reader is.
const readerObserver = new IntersectionObserver(entries => {
	if (!isReader()) return;
	const visible = entries.filter(entry => entry.isIntersecting);
	if (!visible.length) return;
	current = slides.indexOf(visible[0].target);
	setHash();
}, { rootMargin: '-35% 0px -60% 0px' });
slides.forEach(slide => readerObserver.observe(slide));

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

document.addEventListener('keydown', event => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;

	if (event.key === 'p' || event.key === 'P') {
		window.print();
		return;
	}
	// Reader mode is an ordinary page: arrows and space scroll it.
	if (isReader()) return;

	switch (event.key) {
		case 'ArrowRight':
		case 'PageDown':
		case ' ':
			event.preventDefault();
			next();
			break;
		case 'ArrowLeft':
		case 'PageUp':
			event.preventDefault();
			previous();
			break;
		case 'Home':
			event.preventDefault();
			show(0);
			break;
		case 'End':
			event.preventDefault();
			show(slides.length - 1);
			break;
		case 'f':
		case 'F':
			if (document.fullscreenElement) document.exitFullscreen();
			else document.documentElement.requestFullscreen?.();
			break;
		default:
			break;
	}
});

// Clicking advances, except on links, which should still be usable from a slide.
stage.addEventListener('click', event => {
	if (isReader() || event.target.closest('a')) return;
	next();
});

let touchStart = null;
stage.addEventListener('touchstart', event => {
	if (isReader() || event.touches.length !== 1) return;
	touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
}, { passive: true });

stage.addEventListener('touchend', event => {
	if (!touchStart) return;
	const dx = event.changedTouches[0].clientX - touchStart.x;
	const dy = event.changedTouches[0].clientY - touchStart.y;
	touchStart = null;
	if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy)) return;
	// A swipe should not also count as the tap that advances a slide.
	event.preventDefault();
	if (dx < 0) next();
	else previous();
});

window.addEventListener('resize', fitStage);
window.addEventListener('hashchange', () => {
	if (isReader()) slides[slideFromHash()]?.scrollIntoView({ block: 'start' });
	else show(slideFromHash());
});

/*
 * Chrome applies the transform before print styles settle, leaving the first
 * page scaled. Clearing it around the print cycle keeps the PDF clean.
 */
window.addEventListener('beforeprint', () => { stage.style.transform = 'none'; });
window.addEventListener('afterprint', fitStage);

slides.forEach((slide, i) => {
	const label = slide.querySelector('.page-num');
	if (label) label.textContent = `${i + 1} / ${slides.length}`;
});
controls.count.textContent = `${slides.length} slides`;

show(slideFromHash());
fitStage();
if (isReader() && current > 0) slides[current].scrollIntoView({ block: 'start' });
