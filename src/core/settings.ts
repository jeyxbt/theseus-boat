import { get, nowIso, run } from './db/client';

export type SettingKey = 'min_votes' | 'paused' | 'monthly_cap_usd';

export function getSetting(key: SettingKey) {
	return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function getNumberSetting(key: SettingKey, fallback: number) {
	const raw = getSetting(key);
	// Number('') and Number(null) are 0, not "missing".
	if (raw === null || raw.trim() === '') return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

export function setSetting(key: SettingKey, value: string | number) {
	run(
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key,
		String(value),
		nowIso(),
	);
}

/** Minimum votes an idea needs to win a window. */
export function minVotes() {
	return Math.max(1, Math.floor(getNumberSetting('min_votes', 3)));
}
