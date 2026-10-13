// @ts-check
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
	output: 'server',
	adapter: node({ mode: 'standalone' }),
	// 127.0.0.1, not localhost: X only accepts that callback, and cookies are per host.
	server: { host: '127.0.0.1', port: 4321 },
	// Sessions live in the same SQLite, with an expiry.
	session: {
		driver: { entrypoint: new URL('./src/core/db/session-driver.ts', import.meta.url) },
		// 30 days, same as SESSION_TTL_MS in src/core/db/session-ttl.ts.
		ttl: 30 * 24 * 60 * 60,
	},
	// No image optimisation: passthrough keeps /_image inert and drops sharp.
	image: { service: passthroughImageService() },
	security: {
		// Astro's own check trusts the raw socket, not X-Forwarded-Proto: behind a
		// TLS-terminating proxy (Caddy -> plain HTTP to this app) it sees every
		// request as http://, so it rejects every form POST as "cross-site" once a
		// browser sends Origin: https://. same-origin.ts guards every write route
		// already, comparing hostnames (not scheme), so this is redundant and broken
		// here rather than redundant and harmless.
		checkOrigin: false,
	},
	vite: {
		plugins: [tailwindcss()],
		// No inline scripts, so the CSP can be script-src 'self'.
		// Do not empty dist/: a running server loads its routes lazily.
		build: { assetsInlineLimit: 0, emptyOutDir: false },
	},
});
