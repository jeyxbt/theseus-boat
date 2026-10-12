import type { ProviderId } from '../../env';

export type Profile = {
	providerId: string;
	handle: string;
	name: string | null;
	avatarUrl: string | null;
};

export type AuthorizeInput = {
	clientId: string;
	redirectUri: string;
	state: string;
	challenge: string;
};

export type ExchangeInput = {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
	verifier: string;
};

export type OAuthProvider = {
	id: ProviderId;
	label: string;
	authorizeUrl(input: AuthorizeInput): URL;
	exchange(input: ExchangeInput): Promise<Profile>;
};
