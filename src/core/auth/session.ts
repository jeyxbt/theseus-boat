import type { AstroGlobal, APIContext } from 'astro';
import type { Provider, User } from '../db/schema';

export type SessionUser = {
	id: number;
	provider: Provider;
	handle: string;
	name: string | null;
	avatarUrl: string | null;
};

export function toSessionUser(user: User): SessionUser {
	return {
		id: user.id,
		provider: user.provider,
		handle: user.handle,
		name: user.name,
		avatarUrl: user.avatarUrl,
	};
}

type WithSession = Pick<APIContext, 'session'> | Pick<AstroGlobal, 'session'>;

export async function getSessionUser(context: WithSession): Promise<SessionUser | null> {
	return (await context.session?.get('user')) ?? null;
}

/** "@handle" for providers with usernames; the plain name for Google. */
export function displayName(user: Pick<SessionUser, 'provider' | 'handle'>) {
	return user.provider === 'google' ? user.handle : `@${user.handle}`;
}

/** Dev login exists only while running `astro dev`. */
export function devLoginEnabled() {
	return import.meta.env.DEV;
}
