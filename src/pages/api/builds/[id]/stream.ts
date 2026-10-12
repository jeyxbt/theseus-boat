import type { APIRoute } from 'astro';
import { buildById, eventsSince, isActive, isStale } from '../../../../core/builds/queries';
import { intIn } from '../../../../core/http/api';

export const prerender = false;

const POLL_MS = 1000;
const PING_MS = 15_000;
/** The browser reconnects on its own; closing now and then frees idle connections. */
const MAX_OPEN_MS = 10 * 60 * 1000;

/**
 * Server-sent events for a build's log. Sends every line after the client's
 * Last-Event-ID (or ?after=), then follows new lines as the pipeline writes
 * them, and ends with a "done" event once the build has finished.
 */
export const GET: APIRoute = async ({ params, request, url }) => {
	const id = intIn(params.id, 1, 2 ** 31);
	const build = id ? buildById(id) : null;
	if (!id || !build) return new Response('Not found', { status: 404 });

	let last =
		intIn(request.headers.get('last-event-id'), 0, 2 ** 31) ?? intIn(url.searchParams.get('after'), 0, 2 ** 31) ?? 0;

	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;

	const stream = new ReadableStream({
		start(controller) {
			const openedAt = Date.now();
			let lastPing = openedAt;
			let closed = false;

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(timer);
				try {
					controller.close();
				} catch {
					// Already closed by the client.
				}
			};
			const send = (chunk: string) => {
				if (!closed) controller.enqueue(encoder.encode(chunk));
			};

			send('retry: 3000\n\n');

			const pump = () => {
				try {
					for (const event of eventsSince(id, last)) {
						send(`id: ${event.id}\nevent: line\ndata: ${JSON.stringify({ ts: event.ts, tag: event.tag, message: event.message })}\n\n`);
						last = event.id;
					}
					const current = buildById(id);
					if (!current || !isActive(current.status) || isStale(current)) {
						send(`event: done\ndata: ${JSON.stringify({ status: current?.status ?? 'gone' })}\n\n`);
						close();
						return;
					}
					const now = Date.now();
					if (now - lastPing >= PING_MS) {
						send(': ping\n\n');
						lastPing = now;
					}
					if (now - openedAt >= MAX_OPEN_MS) close();
				} catch (error) {
					console.error('[build stream]', error instanceof Error ? error.message : error);
					close();
				}
			};

			pump();
			timer = setInterval(pump, POLL_MS);
			request.signal.addEventListener('abort', close);
		},
		cancel() {
			clearInterval(timer);
		},
	});

	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		},
	});
};
