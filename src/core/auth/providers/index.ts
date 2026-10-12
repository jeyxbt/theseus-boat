import { configuredProviders, type ProviderId } from '../../env';
import { github } from './github';
import { google } from './google';
import type { OAuthProvider } from './types';
import { x } from './x';

const ALL: Record<ProviderId, OAuthProvider> = { github, google, x };

/** Display order on the sign-in page. */
const ORDER: ProviderId[] = ['x', 'google', 'github'];

export function findProvider(id: string | undefined): OAuthProvider | null {
	return id && Object.hasOwn(ALL, id) ? ALL[id as ProviderId] : null;
}

/** Providers whose keys are set in .env, in display order. */
export function enabledProviders(): OAuthProvider[] {
	const configured = new Set(configuredProviders());
	return ORDER.filter((id) => configured.has(id)).map((id) => ALL[id]);
}

export type { OAuthProvider, Profile } from './types';
