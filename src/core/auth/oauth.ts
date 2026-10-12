import { createHash, randomBytes } from 'node:crypto';

export function randomToken(bytes = 32) {
	return randomBytes(bytes).toString('base64url');
}

/** PKCE S256 challenge for a verifier (RFC 7636). */
export function pkceChallenge(verifier: string) {
	return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Where to go after signing in. Only paths on this site: anything that could
 * leave it (//evil.com, /\evil.com, absolute URLs) falls back to the home page.
 */
export function safeReturnTo(raw: unknown) {
	if (typeof raw !== 'string' || raw.length > 512) return '/';
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	if (/[\u0000-\u001F\u007F]/.test(raw)) return '/';
	if (raw.startsWith('/api/')) return '/';
	return raw;
}

/** A display handle from a provider profile: one line, at most 64 characters. */
export function cleanHandle(raw: unknown, fallback: string) {
	const text = typeof raw === 'string' ? raw.normalize('NFC').replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim() : '';
	return (text || fallback).slice(0, 64);
}

export class OAuthError extends Error {
	constructor(
		message: string,
		readonly code: 'denied' | 'auth' = 'auth',
	) {
		super(message);
	}
}

/** fetch → JSON, with a timeout and a readable error. */
export async function fetchJson<T>(url: string, init: RequestInit, label: string): Promise<T> {
	const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
	if (!response.ok) {
		const detail = await response.text().catch(() => '');
		throw new OAuthError(`${label} failed with ${response.status}: ${detail.slice(0, 200)}`);
	}
	return (await response.json()) as T;
}
