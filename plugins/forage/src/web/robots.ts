export interface RobotsRule {
	allow: boolean;
	pattern: string;
}

export interface RobotsGroup {
	userAgents: string[];
	rules: RobotsRule[];
	crawlDelay: number | null;
}

export interface RobotsDocument {
	groups: RobotsGroup[];
	sitemaps: string[];
	truncated: boolean;
}

export interface ParseRobotsOptions {
	maxChars?: number;
	maxGroups?: number;
	maxRules?: number;
	maxSitemaps?: number;
}

const DEFAULT_MAX_CHARS = 512 * 1024;
const DEFAULT_MAX_GROUPS = 1_000;
const DEFAULT_MAX_RULES = 20_000;
const DEFAULT_MAX_SITEMAPS = 1_000;
const MAX_PATTERN_CHARS = 2_048;
const MAX_PATTERN_WILDCARDS = 64;
const MAX_PATH_CHARS = 8_192;
const MAX_MATCH_STEPS = 1_000_000;
const UNRESERVED = /^[A-Za-z0-9._~-]$/;

function normalizedOctets(value: string, preservePattern = false): string | null {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const ch = value[index] ?? "";
		if (preservePattern && (ch === "*" || ch === "$")) {
			result += ch;
			continue;
		}
		if (ch === "%" && /^[0-9a-f]{2}$/i.test(value.slice(index + 1, index + 3))) {
			const encoded = value.slice(index, index + 3).toUpperCase();
			const decoded = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
			result += UNRESERVED.test(decoded) ? decoded : encoded;
			index += 2;
			continue;
		}
		const codePoint = value.codePointAt(index) ?? 0;
		if (codePoint >= 0xd800 && codePoint <= 0xdfff) return null;
		if (codePoint <= 0x7f) {
			result += ch;
			continue;
		}
		result += encodeURIComponent(String.fromCodePoint(codePoint)).toUpperCase();
		if (codePoint > 0xffff) index++;
	}
	return result;
}

function exceedsWildcardLimit(value: string): boolean {
	let wildcards = 0;
	for (const character of value) {
		if (character === "*" && ++wildcards > MAX_PATTERN_WILDCARDS) return true;
	}
	return false;
}

function resolveSitemap(value: string, robotsUrl?: string): string | null {
	try {
		const url = robotsUrl ? new URL(value, robotsUrl) : new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.hash = "";
		return url.href;
	} catch {
		return null;
	}
}

export function parseRobots(text: string, robotsUrl?: string, options: ParseRobotsOptions = {}): RobotsDocument {
	const maxChars = Math.max(0, Math.min(DEFAULT_MAX_CHARS, options.maxChars ?? DEFAULT_MAX_CHARS));
	const maxGroups = Math.max(0, Math.min(DEFAULT_MAX_GROUPS, options.maxGroups ?? DEFAULT_MAX_GROUPS));
	const maxRules = Math.max(0, Math.min(DEFAULT_MAX_RULES, options.maxRules ?? DEFAULT_MAX_RULES));
	const maxSitemaps = Math.max(0, Math.min(DEFAULT_MAX_SITEMAPS, options.maxSitemaps ?? DEFAULT_MAX_SITEMAPS));
	let truncated = text.length > maxChars;
	let source = text.slice(0, maxChars).replace(/^\uFEFF/, "");
	if (/[\uD800-\uDBFF]$/.test(source)) {
		source = source.slice(0, -1);
		truncated = true;
	}
	if (/[\uD800-\uDFFF]/u.test(source)) truncated = true;
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	const sitemapSet = new Set<string>();
	let current: RobotsGroup | null = null;
	let currentSawRule = false;
	let totalRules = 0;

	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		const field = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();
		if (field === "sitemap") {
			if (sitemaps.length >= maxSitemaps) {
				truncated = true;
				continue;
			}
			const resolved = resolveSitemap(value, robotsUrl);
			if (resolved && !sitemapSet.has(resolved)) {
				sitemapSet.add(resolved);
				sitemaps.push(resolved);
			}
			continue;
		}
		if (field === "user-agent") {
			const agent = value.toLowerCase().split(/\s+/, 1)[0] ?? "";
			if (!agent) continue;
			if (!current || currentSawRule) {
				if (groups.length >= maxGroups) {
					truncated = true;
					current = null;
					continue;
				}
				current = { userAgents: [], rules: [], crawlDelay: null };
				currentSawRule = false;
				groups.push(current);
			}
			if (!current.userAgents.includes(agent)) current.userAgents.push(agent);
			continue;
		}
		if (!current?.userAgents.length) continue;
		if (field === "allow" || field === "disallow") {
			currentSawRule = true;
			if (!value) continue;
			if (totalRules >= maxRules) {
				truncated = true;
				continue;
			}
			if (value.length > MAX_PATTERN_CHARS || exceedsWildcardLimit(value)) {
				truncated = true;
				if (field === "disallow") {
					current.rules.push({ allow: false, pattern: "/" });
					totalRules++;
				}
				continue;
			}
			const pattern = normalizedOctets(value, true);
			if (pattern === null || pattern.length > MAX_PATTERN_CHARS) {
				truncated = true;
				if (field === "disallow") {
					current.rules.push({ allow: false, pattern: "/" });
					totalRules++;
				}
				continue;
			}
			current.rules.push({ allow: field === "allow", pattern });
			totalRules++;
		} else if (field === "crawl-delay" && current.crawlDelay === null) {
			const seconds = Number(value);
			if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
		}
	}

	return { groups, sitemaps, truncated };
}

function agentSpecificity(group: RobotsGroup, userAgent: string): number {
	const productToken = userAgent.trim().toLowerCase().split(/[\/\s]/, 1)[0] ?? "";
	let specificity = -1;
	for (const token of group.userAgents) {
		if (token === "*") specificity = Math.max(specificity, 0);
		else if (productToken === token) specificity = Math.max(specificity, token.length);
	}
	return specificity;
}

export function selectRobotsRules(document: RobotsDocument, userAgent: string): RobotsRule[] {
	let best = -1;
	const selected: RobotsRule[] = [];
	for (const group of document.groups) {
		const specificity = agentSpecificity(group, userAgent);
		if (specificity < 0) continue;
		if (specificity > best) {
			best = specificity;
			selected.length = 0;
		}
		if (specificity === best) selected.push(...group.rules);
	}
	return selected;
}

function ruleMatches(pattern: string, path: string, budget: { remaining: number }): boolean | null {
	const anchored = pattern.endsWith("$");
	const body = anchored ? pattern.slice(0, -1) : pattern;
	let patternIndex = 0;
	let pathIndex = 0;
	let starIndex = -1;
	let starPathIndex = -1;

	while (pathIndex <= path.length) {
		if (--budget.remaining < 0) return null;
		if (patternIndex === body.length && (!anchored || pathIndex === path.length)) return true;
		if (body[patternIndex] === "*") {
			starIndex = patternIndex++;
			starPathIndex = pathIndex;
			continue;
		}
		if (pathIndex < path.length && body[patternIndex] === path[pathIndex]) {
			patternIndex++;
			pathIndex++;
			continue;
		}
		if (starIndex >= 0 && starPathIndex < path.length) {
			patternIndex = starIndex + 1;
			pathIndex = ++starPathIndex;
			continue;
		}
		return false;
	}
	return false;
}

function ruleLength(pattern: string): number {
	return pattern.replace(/\*/g, "").replace(/\$$/, "").length;
}

export function isRobotsAllowed(document: RobotsDocument, url: string | URL, userAgent = "ForageBot"): boolean {
	if (document.truncated) return false;
	let target: URL;
	try {
		target = typeof url === "string" ? new URL(url) : url;
	} catch {
		return false;
	}
	const rawPath = `${target.pathname}${target.search}`;
	if (rawPath.length > MAX_PATH_CHARS) return false;
	const path = normalizedOctets(rawPath);
	if (path === null || path.length > MAX_PATH_CHARS) return false;
	let winner: RobotsRule | null = null;
	let winnerLength = -1;
	const matchBudget = { remaining: MAX_MATCH_STEPS };
	for (const rule of selectRobotsRules(document, userAgent)) {
		const matches = ruleMatches(rule.pattern, path, matchBudget);
		if (matches === null) return false;
		if (!matches) continue;
		const length = ruleLength(rule.pattern);
		if (length > winnerLength || (length === winnerLength && rule.allow && !winner?.allow)) {
			winner = rule;
			winnerLength = length;
		}
	}
	return winner?.allow ?? true;
}
