/// <reference types="astro/client" />

declare namespace App {
	interface SessionData {
		user: import('./core/auth/session').SessionUser;
		oauth: {
			provider: import('./core/env').ProviderId;
			state: string;
			verifier: string;
			returnTo: string;
			startedAt: number;
		};
		/** Text of a refused idea, so the form can show it again. */
		draft: string;
	}
}
