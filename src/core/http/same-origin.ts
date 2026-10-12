import { getSiteUrl } from '../env';

/**
 * CSRF defence. Browsers send Origin on cross-site POSTs and Sec-Fetch-Site on
 * everything. If neither arrives, the request didn't come from this site's forms.
 */
export function sameOrigin(request: Request) {
	const origin = request.headers.get('origin');

	if (origin) {
		try {
			return new URL(origin).hostname === new URL(getSiteUrl()).hostname;
		} catch {
			return false;
		}
	}

	const site = request.headers.get('sec-fetch-site');
	return site === 'same-origin' || site === 'none';
}
