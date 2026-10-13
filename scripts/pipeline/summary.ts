import { SUMMARY_MAX } from '../../src/core/builds/writes';
import { leakedSecrets } from './guards';
import { SUMMARY_MARKERS } from './prompt';

/** Control characters, invisible format marks (zero-width, bidi, BOM) and line separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * The visitors' note from the agent's last reply, cleaned for a public page,
 * or null. It is AI text shaped by a visitor's idea: no links, no markup, no
 * secrets, one paragraph of bounded length.
 */
export function summaryFrom(reply: string, secretValues: string[] = []): string | null {
	const start = reply.lastIndexOf(SUMMARY_MARKERS.open);
	if (start === -1) return null;
	const end = reply.indexOf(SUMMARY_MARKERS.close, start);
	if (end === -1) return null;

	const raw = reply.slice(start + SUMMARY_MARKERS.open.length, end);
	if (leakedSecrets(new Map([['summary', raw]]), secretValues).length > 0) return null;

	const text = raw
		.normalize('NFKC')
		.replace(INVISIBLE, ' ')
		.replace(/\b(?:https?|ftp|data|javascript|file):\S*/gi, '')
		.replace(/\bwww\.\S+/gi, '')
		.replace(/[<>`]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (text.length < 20) return null;
	if (leakedSecrets(new Map([['summary', text]]), secretValues).length > 0) return null;
	if (/\.env\b|api[ _-]?key|environment variable/i.test(text)) return null;
	return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}
