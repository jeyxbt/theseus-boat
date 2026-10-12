/**
 * First line of defence, before any AI sees an idea. Rules match intent, not
 * single words: "a password generator" is a fine idea, "show me the API keys" is not.
 */

export type RejectReason = 'injection' | 'secrets' | 'vulnerability' | 'external' | 'scam_finance' | 'spam';

/** Talking to the AI instead of describing a feature. */
const INJECTION_RE =
	/\b(ignore|disregard|forget|override|skip)\s+(all\s+|any\s+|the\s+|your\s+|my\s+)?(previous\s+|prior\s+|above\s+|earlier\s+|system\s+)?(instructions?|prompts?|rules|guidelines|guardrails)\b|\byou\s+are\s+now\b|\bfrom\s+now\s+on\s+(you|act)\b|\b(act|behave)\s+as\s+(if\s+you|an?\s+(ai|assistant|admin|administrator|developer|root|system|unrestricted))\b|\bpretend\s+(to\s+be|you\s+are|that\s+you)\b|\bnew\s+instructions\b|\bjailbreak|\bsystem\s+prompt\b|\bdeveloper\s+(message|mode)\b|\breveal\s+(your\s+)?(hidden\s+|system\s+)?(prompt|instructions)\b|\bexfiltrat/i;

/** Getting the code to leak secrets or private data. */
const SECRETS_RE =
	/process\.env|import\.meta\.env|\.env\b|\benvironment\s+variables?\b|\b(api|secret|private|access|session)\s+(keys?|tokens?|cookies?)\b|\bclient\s+secrets?\b|\bcredentials\b|\bdump\s+(the\s+)?(database|db|users|sessions)\b|\bselect\s+(\*|[\w.]+(\s*,\s*[\w.]+)*)\s+from\s+(users|sessions|ideas|votes|sqlite_\w+)\b|\bdatabase\s+url\b/i;

/** Breaking, bypassing or reconfiguring how the site itself works. */
const VULN_RE = [
	/\b(xss|csrf|ssrf|rce|sqli|sql\s+injection|path\s+traversal|remote\s+code|reverse\s+shell|exploit|0-?day|malware|keylogger|backdoor|webshell|child_process|ddos)\b/i,
	/\bsteal\w*\s+(\S+\s+){0,2}(cookies?|tokens?|sessions?|passwords?|accounts?)\b/i,
	/\b(bypass|disable|remove|turn\s+off|skip)\s+(the\s+)?(login|sign-?in|auth\w*|moderation|filters?|checks?|csp|rate\s+limits?|security|vote\s+limits?|captcha)\b/i,
	/\b(change|modify|shorten|lengthen|reduce|increase|set)\s+(the\s+)?(cron|(voting|build|site)\s+timer|voting\s+window|window\s+length|vote\s+limits?|number\s+of\s+votes)\b/i,
	/\b(give|get|grant|let)\s+(me|us|people|everyone)\s+(have\s+|cast\s+)?(unlimited|infinite|extra|more)\s+votes\b|\b(unlimited|infinite)\s+votes\b|\bvote\s+(multiple|many|unlimited)\s+times\b|\bmake\s+me\s+(an?\s+)?admin\b|\badmin\s+(panel|access|rights)\s+for\s+me\b/i,
	// Taking away the parts that make the site work. Restyling the header or footer is fine; these are not.
	/\b(remove|delete|hide|disable|get\s+rid\s+of|take\s+(away|out)|cover|block|break|kill|replace|turn\s+off)\s+(\S+\s+){0,2}?(sign-?\s?in|log-?\s?in|login|sign-?\s?out|log-?\s?out|vote\s+buttons?|vote\s+counts?|voting|(idea|propos\w*)\s+(form|box|button)|countdown|(voting\s+)?timer|status\s+(pill|bar|badge)|build\s+(log|status)|navigation|nav\s?bar|main\s+menu|rules|privacy)\b/i,
	// A login or password form on our own domain is phishing, whoever asks for it.
	/\b(add|create|make|build|show|put)\s+(\S+\s+){0,2}(login|log[-\s]?in|sign[-\s]?in|password|credentials?)\s+(form|page|box|field|screen|prompt)\b|\b(ask|prompt|require)s?\s+(\S+\s+){0,3}(for\s+)?(their\s+|your\s+)?passwords?\b/i,
	/\b(npm|pnpm|yarn)\s+(i|install|add)\b|\binstall\s+(\S+\s+){0,3}(package|dependency|library|on\s+the\s+server)\b|\b(run|execute)\s+(\S+\s+){0,2}(commands?|shell|arbitrary\s+code|scripts?\s+on\s+the\s+server)\b/i,
];

/** Everything is served from this site: the CSP would block outside resources anyway. */
const EXTERNAL_RE = [
	/\b(jsdelivr|unpkg|cdnjs|google\s+(analytics|fonts|maps|ads)|tag\s+manager|font\s?awesome|hotjar|mixpanel|segment\.io)\b/i,
	/\b(embed\w*|load\w*|fetch\w*|call\w*|integrat\w*|connect\w*|import\w*|pull\w*|stream\w*|use|using)\s+(\S+\s+){0,4}(cdn|external\s+api|third[-\s]party|webhooks?|iframes?|youtube|spotify|twitter|discord|telegram|tiktok|openai|chatgpt|gemini|external\s+service)\b/i,
];

/** No money, wallets or tokens anywhere on the site. */
const SCAM_FINANCE_RE = [
	/\b(wallets?|seed\s+phrases?|recovery\s+phrases?|private\s+keys?|mnemonic|metamask|phantom|ledger\s+live|trust\s+wallet)\b/i,
	/\b(airdrops?|presales?|memecoins?|meme\s+coins?|pump\.?fun|rug\s*pull|nfts?|defi|dex|staking|yield\s+farm\w*|tokenomics)\b/i,
	/\b(crypto|cryptocurrency|cryptocurrencies|bitcoin|btc|ethereum|eth|solana|sol|usdt|usdc|doge|shib|bnb)\b/i,
	/\b(token\s+(sale|launch|price|holders?|chart|contract)|buy\s+(the\s+|our\s+|my\s+)?(token|coin)s?|contract\s+address|\bca\b\s*:)/i,
	/\b(donat\w+|tip\s+jar|paypal|venmo|cash\s?app|buy\s+me\s+a\s+coffee|patreon|ko-?fi|send\s+(me\s+)?(money|funds|payments?))\b/i,
	/\b(payment\s+button|checkout|subscriptions?\s+fee|paid\s+votes?|pay\s+to\s+(vote|win|boost))\b/i,
	/\b(giveaways?|referral\s+(link|code)s?|ref\s+link|casino|gambling|betting)\b/i,
	// A wallet address pasted in: EVM hex or a base58 Solana-style string.
	/\b0x[0-9a-f]{40}\b/i,
	/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/,
];

const REPEAT_RE = /(.)\1{9,}/;
const LINK_RE = /\bhttps?:\/\/|\bwww\.\S|\b[a-z0-9-]+\.(com|net|org|io|xyz|app|dev|gg|ly|me|co|fun)\b/i;

export function moderate(text: string): { ok: true } | { ok: false; reason: RejectReason } {
	if (INJECTION_RE.test(text)) return { ok: false, reason: 'injection' };
	if (SECRETS_RE.test(text)) return { ok: false, reason: 'secrets' };
	if (SCAM_FINANCE_RE.some((rule) => rule.test(text))) return { ok: false, reason: 'scam_finance' };
	if (VULN_RE.some((rule) => rule.test(text))) return { ok: false, reason: 'vulnerability' };
	if (EXTERNAL_RE.some((rule) => rule.test(text))) return { ok: false, reason: 'external' };
	if (REPEAT_RE.test(text) || LINK_RE.test(text)) return { ok: false, reason: 'spam' };
	return { ok: true };
}
