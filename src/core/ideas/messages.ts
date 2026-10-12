import type { IdeaError } from './queries';

/** What the author sees when an idea is refused. Only they see it. */
export const IDEA_ERRORS: Record<IdeaError | 'signin' | 'origin' | 'slow', string> = {
	length: 'Ideas need 16 to 280 characters.',
	injection: 'That reads like instructions for the AI. Describe the feature you want instead.',
	secrets: 'Ideas can’t ask for keys, secrets or anyone’s private data.',
	vulnerability: 'Ideas can’t break, bypass, hide or remove how sign-in, voting, proposing and the rest of the site work. Restyling and adding things is fine.',
	external: 'Everything here runs on this site. Ideas can’t pull in outside services, embeds or CDNs.',
	scam_finance: 'No wallets, tokens, payments or donations. This site stays free of money.',
	spam: 'Looks like spam: links and long runs of one character aren’t allowed.',
	duplicate: 'A very similar idea is already on the board. Vote for it instead.',
	has_idea: 'You already have an idea on the board. Edit it or withdraw it first.',
	not_found: 'That idea isn’t yours, or its window has already closed.',
	no_edits: 'You’ve used all 3 edits. You can still withdraw it and propose a new one.',
	unchanged: 'Nothing changed, so no edit was used.',
	window_closed: 'This voting window just closed. Your idea can go into the next one.',
	already_built: 'That’s already been built. Propose something that builds on it instead.',
	harmful: 'Ideas can’t target or demean people, or collect anyone’s personal data.',
	off_topic: 'That isn’t a feature or a change for this website. Describe something the site could do.',
	signin: 'Sign in to propose an idea.',
	origin: 'That request didn’t come from this site.',
	slow: 'Too many tries. Wait a bit and try again.',
};

export const IDEA_OK: Record<string, string> = {
	submitted: 'Your idea is on the board. Now get people to vote for it.',
	edited: 'Saved. Its votes were reset: people voted for the old wording.',
	withdrawn: 'Withdrawn. Votes for it went back to the people who cast them.',
	closed: 'Window closed. A new one is open: the board starts empty.',
};
