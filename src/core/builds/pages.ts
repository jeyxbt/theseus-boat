/** Routes of the pages a change touched: src/pages/garden.astro → /garden. Dynamic routes are skipped. */
export function routesFor(files: string[]) {
	return files
		.filter((file) => /^src\/pages\/.+\.astro$/.test(file) && !file.includes('['))
		.map((file) => file.slice('src/pages'.length).replace(/\.astro$/, '').replace(/\/index$/, '') || '/');
}

type Shipped = { status: string; files: string[]; dryRun?: boolean };

/** The pages a shipped build added or changed, other than the home page, as links a visitor can open. */
export function pageLinks(build: Shipped) {
	if (build.status !== 'live' || build.dryRun) return [];
	return routesFor(build.files).filter((route) => route !== '/' && /^(\/[a-z0-9][a-z0-9-]*)+$/i.test(route));
}

/** Where a visitor can see a shipped change: its own pages first, then the home page if it changed. */
export function whereToSee(build: Shipped) {
	const links = pageLinks(build).map((route) => ({ href: route, label: `Open ${route}` }));
	if (build.status === 'live' && !build.dryRun && routesFor(build.files).includes('/')) {
		links.push({ href: '/', label: 'See it on the home page' });
	}
	return links;
}
