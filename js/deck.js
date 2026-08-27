'use strict';

/*
 * Presentation shell.
 *
 * Slides live on a fixed 1280x720 stage so a slide looks identical on a
 * laptop, a projector and a printed PDF. The stage is scaled to whatever
 * viewport it finds rather than the layout reflowing, which is what keeps
 * a rehearsed slide from rearranging itself in the room.
 */

const stage = document.getElementById('stage');
const progress = document.getElementById('progress');
const slides = Array.from(document.querySelectorAll('.slide'));

const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;
const MARGIN = 0.94; // breathing room so the stage never touches the screen edge

let current = 0;

/* ------------------------------------------------------------------ *
 * Scaling
 * ------------------------------------------------------------------ */

function fitStage() {
	// Printing lays the slides out as real pages, so the transform must not apply.
	if (window.matchMedia('print').matches) return;
	const scale = Math.min(
		(window.innerWidth * MARGIN) / STAGE_WIDTH,
		(window.innerHeight * MARGIN) / STAGE_HEIGHT
	);
	stage.style.transform = `scale(${scale})`;
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function show(index) {
	current = Math.max(0, Math.min(slides.length - 1, index));

	slides.forEach((slide, i) => {
		if (i === current) slide.setAttribute('data-active', '');
		else slide.removeAttribute('data-active');
	});

	progress.style.width = `${((current + 1) / slides.length) * 100}%`;

	const label = slides[current].querySelector('.page-num');
	if (label) label.textContent = `${current + 1} / ${slides.length}`;

	// Reflected in the URL so a specific slide can be linked or reloaded into.
	const hash = `#${current + 1}`;
	if (window.location.hash !== hash) history.replaceState(null, '', hash);
}

function next() { show(current + 1); }
function previous() { show(current - 1); }

function slideFromHash() {
	const parsed = Number.parseInt(window.location.hash.slice(1), 10);
	return Number.isFinite(parsed) ? parsed - 1 : 0;
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */

document.addEventListener('keydown', event => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;

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
		case 'p':
		case 'P':
			window.print();
			break;
		default:
			break;
	}
});

// Clicking advances, except on links, which should still be usable from a slide.
stage.addEventListener('click', event => {
	if (event.target.closest('a')) return;
	next();
});

window.addEventListener('resize', fitStage);
window.addEventListener('hashchange', () => show(slideFromHash()));

/*
 * Chrome applies the transform before print styles settle, leaving the first
 * page scaled. Clearing it around the print cycle keeps the PDF clean.
 */
window.addEventListener('beforeprint', () => { stage.style.transform = 'none'; });
window.addEventListener('afterprint', fitStage);

fitStage();
show(slideFromHash());
