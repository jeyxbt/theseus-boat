import { get, nowIso } from '../db/client';
import type { Provider, User } from '../db/schema';
import type { Profile } from './providers/types';

const USER_COLUMNS = `id, provider, provider_id AS providerId, handle, name, avatar_url AS avatarUrl, created_at AS createdAt`;

/** Creates the account on first sign-in; later sign-ins refresh handle, name and avatar. */
export function upsertUser(provider: Provider, profile: Profile): User {
	const user = get<User>(
		`INSERT INTO users (provider, provider_id, handle, name, avatar_url, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT (provider, provider_id) DO UPDATE SET
			handle = excluded.handle,
			name = excluded.name,
			avatar_url = excluded.avatar_url
		 RETURNING ${USER_COLUMNS}`,
		provider,
		profile.providerId,
		profile.handle,
		profile.name,
		profile.avatarUrl,
		nowIso(),
	);
	if (!user) throw new Error(`Could not save ${provider} user`);
	return user;
}

export function getUserById(id: number) {
	return get<User>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
}
