import type { APIRoute } from 'astro';
import { get } from '../../core/db/client';

export const prerender = false;

/** Answers 200 only when the app can reach its database: what a monitor and a restart script want to know. */
export const GET: APIRoute = async () => {
	try {
		get('SELECT 1 AS ok');
		return Response.json({ ok: true, at: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
	} catch {
		return Response.json({ ok: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
	}
};
