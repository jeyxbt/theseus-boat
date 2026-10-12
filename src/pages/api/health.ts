import type { APIRoute } from 'astro';

export const prerender = false;

export const GET: APIRoute = async () => {
	return Response.json({ ok: true, at: new Date().toISOString() });
};
