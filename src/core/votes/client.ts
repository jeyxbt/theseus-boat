/**
 * Voting on the ideas board. The page is rendered on the server with the right
 * states; this script only takes over clicks and keeps counts fresh.
 */
import { endWindow } from '../cycle/countdown';

const POLL_MS = 20_000;

type Snapshot = {
	ideas: { id: number; votes: number }[];
	mine: number[];
	used: number;
	max: number;
	window: { id: number; number: number; closesAt: string };
};

const MESSAGES: Record<string, string> = {
	window_closed: 'This voting window has closed. The results are being counted.',
	no_votes_left: 'You’ve used all 3 votes. Take one back to vote for something else.',
	not_found: 'That idea isn’t on the board any more.',
	own_idea: 'You can’t vote for your own idea.',
	slow: 'Slow down a little and try again.',
	failed: 'Couldn’t save your vote. Check your connection and try again.',
};

export function startVoting(root: HTMLElement) {
	const max = Number(root.dataset.max ?? 3);
	const signedIn = root.dataset.signedIn === '1';
	const windowId = Number(root.dataset.windowId);
	let mine: number[] = JSON.parse(root.dataset.mine ?? '[]');
	let closed = false;

	const rows = () => [...root.querySelectorAll<HTMLElement>('[data-idea]')];
	const message = root.querySelector<HTMLElement>('[data-vote-message]');

	function say(text: string) {
		if (message) message.textContent = text;
	}

	function render() {
		const used = mine.length;
		for (const row of rows()) {
			const id = Number(row.dataset.idea);
			const voted = mine.includes(id);
			row.querySelector('[data-bar]')?.classList.toggle('bg-accent', voted);
			row.querySelector('[data-bar]')?.classList.toggle('bg-ink', !voted);

			const button = row.querySelector<HTMLButtonElement>('button[data-vote]');
			if (!button) continue;
			if (closed) {
				button.dataset.state = 'closed';
				button.disabled = true;
				continue;
			}
			if (button.dataset.state === 'own') continue;
			const state = voted ? 'voted' : used >= max ? 'locked' : 'vote';
			button.dataset.state = state;
			button.disabled = state === 'locked';
			button.setAttribute('aria-pressed', String(voted));
		}

		const usedLabel = root.querySelector('[data-votes-used]');
		if (usedLabel) usedLabel.textContent = String(used);

		const slots = root.querySelectorAll<HTMLElement>('[data-slot]');
		slots.forEach((slot, index) => {
			const id = mine[index];
			const row = id ? root.querySelector<HTMLElement>(`[data-idea="${id}"]`) : null;
			slot.textContent = id ? (row ? `#${String(row.dataset.rank).padStart(2, '0')}` : '#—') : 'free';
			slot.classList.toggle('bg-accent', Boolean(id));
			slot.classList.toggle('bg-card', !id);
		});
	}

	function setCount(id: number, votes: number) {
		const row = root.querySelector<HTMLElement>(`[data-idea="${id}"]`);
		const label = row?.querySelector('[data-votes]');
		if (label) label.textContent = String(votes);
	}

	/** Bars are relative to the most-voted idea on the page. */
	function resizeBars() {
		const counts = rows().map((row) => Number(row.querySelector('[data-votes]')?.textContent ?? 0));
		const top = Math.max(0, ...counts);
		rows().forEach((row, index) => {
			const bar = row.querySelector<HTMLElement>('[data-bar]');
			if (bar) bar.style.width = `${top > 0 ? Math.round((counts[index] / top) * 100) : 0}%`;
		});
	}

	async function refresh() {
		try {
			const response = await fetch('/api/votes', { headers: { Accept: 'application/json' } });
			if (!response.ok) return;
			const snapshot = (await response.json()) as Snapshot;
			// A new window opened (closed early, or while this tab slept): same handling as the timer.
			if (Number.isFinite(windowId) && snapshot.window.id !== windowId) {
				endWindow(0);
				return;
			}
			for (const { id, votes } of snapshot.ideas) setCount(id, votes);
			if (signedIn) mine = snapshot.mine;
			resizeBars();
			render();
		} catch {
			// Offline for a moment: the next poll catches up.
		}
	}

	async function toggle(button: HTMLButtonElement) {
		const id = Number(button.dataset.vote);
		button.setAttribute('aria-busy', 'true');
		say('');
		try {
			const response = await fetch('/api/votes', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
				body: JSON.stringify({ ideaId: id }),
			});

			if (response.status === 401) {
				location.href = `/signin?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
				return;
			}

			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				say(MESSAGES[data.error] ?? MESSAGES.failed);
				await refresh();
				return;
			}

			mine = data.voted ? [...mine, id] : mine.filter((other) => other !== id);
			setCount(id, data.votes);
			resizeBars();
			render();
			button.classList.remove('pw-pop');
			void button.offsetWidth;
			button.classList.add('pw-pop');
		} catch {
			say(MESSAGES.failed);
		} finally {
			button.removeAttribute('aria-busy');
		}
	}

	document.addEventListener('pw:window-closed', () => {
		closed = true;
		render();
	});

	root.addEventListener('click', (event) => {
		const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-vote]');
		if (!button || button.disabled || button.getAttribute('aria-busy') === 'true') return;
		void toggle(button);
	});

	setInterval(() => {
		if (document.visibilityState === 'visible') void refresh();
	}, POLL_MS);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void refresh();
	});
}
