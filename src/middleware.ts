import { defineMiddleware } from 'astro:middleware';
import { tickWindows } from './core/cycle/windows';
import { reviewPending } from './core/moderation/board';

/** How often the server checks whether the voting window is due to close. */
const TICK_MS = 15_000;

type CycleGlobal = typeof globalThis & {
	__pwCycleTimer?: ReturnType<typeof setInterval>;
	__pwTick?: () => void;
	__pwReview?: () => void;
};

/**
 * Keeps the voting cycle on time: every request brings it up to date, and a
 * timer closes windows even when nobody is visiting. The timer starts on the
 * first request, never at build time. The tick function lives on globalThis so
 * a hot reload swaps it without starting a second timer.
 */
function keepCycleMoving() {
	const g = globalThis as CycleGlobal;
	g.__pwTick = () => {
		try {
			tickWindows();
		} catch (error) {
			console.error('[cycle] tick failed:', error instanceof Error ? error.message : error);
		}
	};
	// Ideas that went up while the AI review was unreachable get reviewed in the background.
	g.__pwReview = () => {
		reviewPending().catch((error) => console.error('[moderation] background review failed:', error instanceof Error ? error.message : error));
	};
	if (!g.__pwCycleTimer) {
		g.__pwCycleTimer = setInterval(() => {
			g.__pwTick?.();
			g.__pwReview?.();
		}, TICK_MS);
		g.__pwCycleTimer.unref();
	}
	g.__pwTick();
}

// Everything is served from this origin: no CDN, no third-party scripts.
const CSP = [
	"default-src 'self'",
	"script-src 'self'",
	// Astro may inline styles while building a page.
	"style-src 'self' 'unsafe-inline'",
	// Avatars come from the sign-in providers.
	"img-src 'self' data: https://avatars.githubusercontent.com https://lh3.googleusercontent.com https://pbs.twimg.com",
	"font-src 'self'",
	"connect-src 'self'",
	"form-action 'self'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
	"object-src 'none'",
].join('; ');

export const onRequest = defineMiddleware(async (_context, next) => {
	keepCycleMoving();
	const response = await next();

	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');

	// Pages show live state (the timer, votes, who is signed in): a copy restored from
	// the browser cache would show an old countdown for hours.
	if ((response.headers.get('content-type') ?? '').includes('text/html') && !response.headers.has('cache-control')) {
		response.headers.set('Cache-Control', 'private, no-store');
	}

	// In dev, Astro injects inline scripts for hot reload.
	if (import.meta.env.PROD) {
		response.headers.set('Content-Security-Policy', CSP);
	}

	return response;
});
