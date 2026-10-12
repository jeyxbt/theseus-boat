import type { BuildStatus } from '../db/schema';
import { stepStates } from './steps';

/**
 * Browser side of the live build page: follows the build's event stream,
 * appends each new log line, and reloads when a step changes or the build
 * ends, so the server renders the new state. EventSource reconnects on its own
 * and resumes from the last line it saw.
 */

const TAG_COLOURS: Record<string, string> = {
	window: 'text-sun',
	winner: 'text-sun',
	git: 'text-sun',
	ai: 'text-info',
	build: 'text-info',
	deploy: 'text-info',
	checks: 'text-ok',
	guard: 'text-ok',
	smoke: 'text-ok',
	repair: 'text-accent-soft',
	rollback: 'text-bad',
	failed: 'text-bad',
	live: 'text-accent',
};

function clock(iso: string) {
	return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

function lineElement(event: { ts: string; tag: string; message: string }) {
	const row = document.createElement('div');
	row.className = 'pw-in whitespace-pre';
	const time = document.createElement('span');
	time.className = 'text-dim';
	time.textContent = clock(event.ts);
	const tag = document.createElement('span');
	tag.className = `inline-block w-[7ch] ${TAG_COLOURS[event.tag] ?? 'text-silver'}`;
	tag.textContent = event.tag;
	const message = document.createElement('span');
	message.className = 'text-[#e6e8eb]';
	message.textContent = event.message;
	row.append(time, '  ', tag, '  ', message);
	return row;
}

export function followBuild(root: HTMLElement) {
	const buildId = root.dataset.buildId;
	const status = root.dataset.status as BuildStatus;
	const log = root.querySelector<HTMLElement>('[data-build-log]');
	const caret = root.querySelector('[data-build-caret]');
	if (!buildId || !log) return;

	const tags: string[] = JSON.parse(root.dataset.tags ?? '[]');
	const stepsBefore = JSON.stringify(stepStates(status, tags));
	let reloading = false;
	const reloadSoon = () => {
		if (reloading) return;
		reloading = true;
		setTimeout(() => location.reload(), 1200);
	};

	const source = new EventSource(`/api/builds/${buildId}/stream?after=${root.dataset.lastEventId ?? 0}`);

	source.addEventListener('line', (message) => {
		const event = JSON.parse((message as MessageEvent).data) as { ts: string; tag: string; message: string };
		log.insertBefore(lineElement(event), caret);
		tags.push(event.tag);
		if (JSON.stringify(stepStates(status, tags)) !== stepsBefore) reloadSoon();
	});

	source.addEventListener('done', () => {
		source.close();
		reloadSoon();
	});
}
