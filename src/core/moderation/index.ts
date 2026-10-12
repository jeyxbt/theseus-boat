/**
 * AI review of ideas, on top of the regex filter in ideas/moderation.ts.
 *
 *   submit  — Claude Haiku, when an idea is proposed or edited. If it can't be
 *             reached in time, the idea goes up regex-checked only and is
 *             reviewed again in the background.
 *   final   — Claude Sonnet, on the winner right before it is built. Fail-closed:
 *             no answer means no build.
 *
 * MODERATION_PROVIDER picks how the model is reached: "cli" (Claude Code with
 * a logged-in subscription, the default), "api" (ANTHROPIC_API_KEY) or "off".
 */
import { apiProvider } from './api';
import { cliProvider } from './cli';
import {
	AI_CATEGORIES,
	SYSTEM_PROMPTS,
	VERDICT_SCHEMA,
	fenceIdea,
	type AiCategory,
	type AiVerdict,
	type ModerationProvider,
	type Stage,
} from './types';

export type { AiCategory, AiVerdict, Stage } from './types';

export type ModerationMode = 'cli' | 'api' | 'off';

export function moderationMode(): ModerationMode {
	const value = process.env.MODERATION_PROVIDER;
	return value === 'api' || value === 'off' ? value : 'cli';
}

const ms = (value: string | undefined, fallback: number) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const SETTINGS: Record<Stage, { model: () => string; effort: 'low' | 'medium'; timeoutMs: () => number }> = {
	submit: {
		model: () => process.env.MODERATION_MODEL || 'claude-haiku-5-5',
		effort: 'low',
		timeoutMs: () => ms(process.env.MODERATION_TIMEOUT_MS, 15_000),
	},
	final: {
		model: () => process.env.FINAL_GATE_MODEL || 'claude-sonnet-5-5',
		effort: 'medium',
		timeoutMs: () => ms(process.env.FINAL_GATE_TIMEOUT_MS, 120_000),
	},
};

let override: ModerationProvider | null = null;

/** For tests: answer every review with this provider instead of a real model. Pass null to undo. */
export function setModerationProviderForTests(provider: ModerationProvider | null) {
	override = provider;
}

function interpret(value: unknown, model: string, costUsd: number): AiVerdict {
	const answer = value as { verdict?: unknown; category?: unknown; reason?: unknown } | null;
	const reason = typeof answer?.reason === 'string' ? answer.reason.slice(0, 300) : '';
	if (answer?.verdict === 'allow') return { status: 'allow', model, costUsd };
	if (answer?.verdict === 'reject' && AI_CATEGORIES.includes(answer.category as AiCategory)) {
		return { status: 'reject', category: answer.category as AiCategory, reason, model, costUsd };
	}
	return { status: 'unavailable', error: 'the answer did not match the expected shape', model, costUsd };
}

export async function reviewIdea(text: string, stage: Stage): Promise<AiVerdict> {
	const settings = SETTINGS[stage];
	const model = settings.model();
	const mode = moderationMode();
	if (mode === 'off' && !override) return { status: 'allow', model: 'off', costUsd: 0 };

	const provider = override ?? (mode === 'api' ? apiProvider : cliProvider);
	try {
		const result = await provider({
			model,
			system: SYSTEM_PROMPTS[stage],
			user: fenceIdea(text),
			schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
			effort: settings.effort,
			timeoutMs: settings.timeoutMs(),
		});
		if (result.kind === 'refused') {
			return { status: 'reject', category: 'harmful', reason: `the model declined to review it (${result.detail})`, model, costUsd: result.costUsd };
		}
		return interpret(result.value, model, result.costUsd);
	} catch (error) {
		return { status: 'unavailable', error: error instanceof Error ? error.message : String(error), model, costUsd: 0 };
	}
}
