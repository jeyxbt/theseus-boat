import type { APIContext } from 'astro';
import { sameOrigin } from './same-origin';

export function json(data: unknown, status = 200) {
	return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

export function fail(status: number, error: string) {
	return json({ error }, status);
}

/**
 * Every JSON write must come from this site. A form on another site can't send
 * application/json without CORS, which is never opened here.
 */
export function rejectWrite(context: APIContext) {
	if (!sameOrigin(context.request)) return fail(403, 'origin');
	const type = context.request.headers.get('content-type') ?? '';
	if (context.request.method !== 'DELETE' && !type.startsWith('application/json')) return fail(415, 'json');
	return null;
}

/** JSON body with a size cap. */
export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 4096) {
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > maxBytes) return null;
	const text = await request.text();
	if (text.length > maxBytes) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null;
	} catch {
		return null;
	}
}

/**
 * The proxy sends the real IP; the app listens on 127.0.0.1 only, so it can be
 * trusted. IPv6 is grouped by /64, since a connection usually gets a whole block.
 */
export function clientIp(request: Request) {
	const ip = request.headers.get('x-real-ip') ?? '127.0.0.1';
	if (!ip.includes(':')) return ip;
	return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
}

function expandIpv6(ip: string) {
	const [head, tail = ''] = ip.split('::');
	const left = head ? head.split(':') : [];
	const right = tail ? tail.split(':') : [];
	const zeros = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
	return [...left, ...(ip.includes('::') ? zeros : []), ...right].map((part) => part.toLowerCase() || '0');
}

// C0 and C1 control characters.
const CONTROL = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');
// Zero-width characters, bidi marks and invisible separators.
const INVISIBLE = new RegExp('[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF]', 'g');

/** Single-line clean text. null if empty or outside the length bounds. */
export function cleanText(raw: unknown, max: number, { min = 1 } = {}) {
	if (typeof raw !== 'string') return null;
	// Line breaks and tabs become spaces first, so "one⏎two" doesn't turn into "onetwo".
	const text = raw
		.normalize('NFC')
		.replace(/[\t\n\v\f\r]+/g, ' ')
		.replace(CONTROL, '')
		.replace(INVISIBLE, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length < min || text.length > max) return null;
	return text;
}

const REPEAT_RE = /(.)\1{9,}/;
const LINK_RE = /\bhttps?:\/\/|\bwww\.\S/i;

/** Obvious noise: long runs of one character, or links. */
export function looksLikeSpam(text: string) {
	return REPEAT_RE.test(text) || LINK_RE.test(text);
}

/** An integer within a range, or null. */
export function intIn(raw: unknown, min: number, max: number) {
	const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
	return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}
