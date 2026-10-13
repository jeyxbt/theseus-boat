/** Routes of the pages a change touched: src/pages/garden.astro → /garden. Dynamic routes are skipped. */
export function routesFor(files: string[]) {
	return files
		.filter((file) => /^src\/pages\/.+\.astro$/.test(file) && !file.includes('['))
		.map((file) => file.slice('src/pages'.length).replace(/\.astro$/, '').replace(/\/index$/, '') || '/');
}

/** The pages a shipped build added or changed, other than the home page, as links a visitor can open. */
export function pageLinks(build: { status: string; files: string[] }) {
	if (build.status !== 'live') return [];
	return routesFor(build.files).filter((route) => route !== '/' && /^(\/[a-z0-9][a-z0-9-]*)+$/i.test(route));
}
