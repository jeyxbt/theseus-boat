/**
 * Browser side of the voting timer. Every element with data-countdown counts
 * down to its data-closes-at, corrected for the difference between the
 * visitor's clock and the server's. When the window ends, the page is marked
 * as ended and reloaded to show the result — unless someone has an idea typed
 * that isn't saved yet, in which case a notice asks them to reload themselves.
 */

const RELOAD_AFTER_MS = 4000;
const ONE_SHOT_PARAMS = ['ok', 'error', 'similar', 'built'];

type Flagged = Window & { __pwCountdown?: boolean; __pwWindowEnded?: boolean };

const pad = (n: number) => String(n).padStart(2, '0');

function split(ms: number) {
	const seconds = Math.max(0, Math.ceil(ms / 1000));
	return { hh: pad(Math.floor(seconds / 3600)), mm: pad(Math.floor((seconds % 3600) / 60)), ss: pad(seconds % 60) };
}

/**
 * True when an idea form holds text that would be lost by a reload: anything
 * non-empty that differs from the idea as saved (data-saved; empty for a new
 * idea). A refused draft the server put back in the form counts.
 */
export function hasUnsavedIdea() {
	return [...document.querySelectorAll<HTMLTextAreaElement>('[data-idea-input]')].some((input) => {
		const text = input.value.trim();
		return text !== '' && text !== (input.dataset.saved ?? '').trim();
	});
}

/** This page's URL without one-shot messages, so a reload doesn't show an old flash again. */
function freshUrl() {
	const url = new URL(location.href);
	for (const key of ONE_SHOT_PARAMS) url.searchParams.delete(key);
	url.hash = '';
	return url.toString();
}

/** The window this page shows is over. Runs once per page, however it was noticed. */
export function endWindow(delayMs = RELOAD_AFTER_MS) {
	const flagged = window as Flagged;
	if (flagged.__pwWindowEnded) return;
	flagged.__pwWindowEnded = true;

	for (const node of document.querySelectorAll<HTMLElement>('[data-countdown]')) node.dataset.ended = 'true';
	document.dispatchEvent(new CustomEvent('pw:window-closed'));

	setTimeout(() => {
		if (hasUnsavedIdea()) {
			for (const notice of document.querySelectorAll<HTMLElement>('[data-window-ended]')) notice.hidden = false;
		} else {
			location.replace(freshUrl());
		}
	}, delayMs);
}

export function startCountdowns() {
	const flagged = window as Flagged;
	if (flagged.__pwCountdown) return;
	const nodes = [...document.querySelectorAll<HTMLElement>('[data-countdown]')];
	if (nodes.length === 0) return;
	flagged.__pwCountdown = true;

	// Pages are sent with no-store, so the server time in them is fresh.
	const serverNow = Number(nodes[0].dataset.serverNow);
	const offset = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;

	// Times are rendered on the server; show them in the visitor's own time zone.
	for (const node of document.querySelectorAll<HTMLElement>('[data-local-time]')) {
		const at = new Date(node.dataset.localTime ?? '');
		if (!Number.isNaN(at.getTime())) {
			node.textContent = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
		}
	}

	function render() {
		const now = Date.now() + offset;
		let ended = false;
		for (const node of nodes) {
			const closes = Date.parse(node.dataset.closesAt ?? '');
			const opened = Date.parse(node.dataset.openedAt ?? '');
			const left = closes - now;
			if (left <= 0) ended = true;

			const parts = split(left);
			for (const key of ['hh', 'mm', 'ss'] as const) {
				const part = node.querySelector(`[data-countdown-${key}]`);
				if (part) part.textContent = parts[key];
			}
			const clock = node.querySelector('[data-countdown-clock]');
			if (clock) clock.textContent = `${parts.hh}:${parts.mm}:${parts.ss}`;

			const bar = node.querySelector<HTMLElement>('[data-countdown-bar]');
			if (bar && closes > opened) {
				const done = Math.min(1, Math.max(0, (now - opened) / (closes - opened)));
				bar.style.width = `${(done * 100).toFixed(2)}%`;
			}
		}
		if (ended) endWindow();
	}

	render();
	setInterval(render, 1000);
}
