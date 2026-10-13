/**
 * The project's name, in one place. Renaming the site is this file, plus the
 * README and LICENSE.
 */
export const SITE_NAME = 'Theseus';

/** Lowercase, for machine-facing identifiers: a User-Agent, the bot's commit name. */
export const SITE_SLUG = 'theseus';

/** The public repository every shipped change is pushed to. */
export const REPO_URL = 'https://github.com/jeyxbt/theseus-boat';

export function commitUrl(sha: string | null | undefined) {
	return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? `${REPO_URL}/commit/${sha}` : null;
}
