import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isRobotsAllowed, parseRobots, selectRobotsRules } from "../../src/web/robots.ts";

describe("robots parser", () => {
	const document = parseRobots(`
User-agent: *
Disallow: /private/
Disallow: /*.pdf$
Allow: /private/public.pdf$
Sitemap: /sitemap.xml

User-agent: ForageBot
Disallow: /tmp
Allow: /tmp/public
Disallow: /encoded/%7Esecret

User-agent: ForageBot-News
Disallow: /
`, "https://example.com/robots.txt");

	it("selects the most specific user-agent groups and resolves sitemaps", () => {
		const selected = selectRobotsRules(document, "ForageBot/0.2");
		assert.deepEqual(selected.map((rule) => ({ allow: rule.allow, pattern: rule.pattern })), [
			{ allow: false, pattern: "/tmp" },
			{ allow: true, pattern: "/tmp/public" },
			{ allow: false, pattern: "/encoded/~secret" },
		]);
		assert.deepEqual(document.sitemaps, ["https://example.com/sitemap.xml"]);
	});

	it("uses longest matching rules, with Allow winning ties", () => {
		assert.equal(isRobotsAllowed(document, "https://example.com/tmp/no", "ForageBot"), false);
		assert.equal(isRobotsAllowed(document, "https://example.com/tmp/public/page", "ForageBot"), true);
		assert.equal(isRobotsAllowed(document, "https://example.com/elsewhere", "ForageBot"), true);
	});

	it("supports wildcards/end anchors and normalized percent encoding", () => {
		assert.equal(isRobotsAllowed(document, "https://example.com/report.pdf", "OtherBot"), false);
		assert.equal(isRobotsAllowed(document, "https://example.com/report.pdf?download=1", "OtherBot"), true);
		assert.equal(isRobotsAllowed(document, "https://example.com/private/public.pdf", "OtherBot"), true);
		assert.equal(isRobotsAllowed(document, "https://example.com/encoded/~secret", "ForageBot"), false);
	});

	it("backtracks bounded wildcards when an end anchor has not consumed the path", () => {
		for (const [pattern, path, allowed] of [
			["/*.pdf$", "/a.pdf/b.pdf", false],
			["/private*$", "/private/x", false],
			["/*$", "/x", false],
			["/*.pdf$", "/a.pdf/b.txt", true],
			["/private*$", "/public/x", true],
			["/*a*b$", "/a/ab/ab", false],
		] as const) {
			const rules = parseRobots(`User-agent: *\nDisallow: ${pattern}\n`);
			assert.equal(isRobotsAllowed(rules, `https://example.com${path}`), allowed, `${pattern} against ${path}`);
		}
		const rules = parseRobots("User-agent: *\nDisallow: /*$\nAllow: /public*$\n");
		assert.equal(isRobotsAllowed(rules, "https://example.com/public/x"), true);
	});

	it("fails closed on lone surrogates and a size cap inside a surrogate pair", () => {
		for (const surrogate of ["\uD800", "\uDC00"]) {
			const rules = parseRobots(`User-agent: *\nDisallow: /${surrogate}\n`);
			assert.equal(rules.truncated, true);
			assert.equal(isRobotsAllowed(rules, "https://example.com/public"), false);
		}
		const prefix = "User-agent: *\nDisallow: /";
		const text = "#" + "x".repeat(512 * 1024 - prefix.length - 3) + "\n" + prefix + "😀";
		const rules = parseRobots(text);
		assert.equal(rules.truncated, true);
		assert.equal(isRobotsAllowed(rules, "https://example.com/public"), false);
		const cut = parseRobots(prefix + "😀", undefined, { maxChars: prefix.length + 1 });
		assert.equal(cut.truncated, true);
		assert.equal(isRobotsAllowed(cut, "https://example.com/public"), false);
		assert.equal(parseRobots(prefix + "😀").truncated, false);
	});

	it("uses the longest matching user-agent token", () => {
		assert.equal(isRobotsAllowed(document, "https://example.com/anything", "ForageBot-News/1.0"), false);
	});

	it("matches UTF-8 paths against percent-encoded rules", () => {
		const unicode = parseRobots("User-agent: *\nDisallow: /caf%C3%A9\n");
		assert.equal(isRobotsAllowed(unicode, "https://example.com/café", "ForageBot"), false);
	});

	it("continues groups across blank lines and starts a new group after empty rules", () => {
		const continued = parseRobots("User-agent: *\nDisallow: /a\n\nDisallow: /b\n");
		assert.equal(isRobotsAllowed(continued, "https://example.com/b", "ForageBot"), false);

		const separated = parseRobots("User-agent: a\nDisallow:\nUser-agent: ForageBot\nDisallow: /\n");
		assert.equal(isRobotsAllowed(separated, "https://example.com/x", "a"), true);
		assert.equal(isRobotsAllowed(separated, "https://example.com/x", "ForageBot"), false);
	});

	it("matches product tokens exactly instead of by substring", () => {
		const botOnly = parseRobots("User-agent: bot\nDisallow: /\n");
		assert.equal(isRobotsAllowed(botOnly, "https://example.com/x", "ForageBot/1.0"), true);
		assert.equal(isRobotsAllowed(botOnly, "https://example.com/x", "bot/1.0"), false);
	});

	it("matches hostile wildcard rules without backtracking", () => {
		const hostile = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(6)}b\n`);
		const started = performance.now();
		assert.equal(isRobotsAllowed(hostile, `https://example.com/${"a".repeat(50)}`), true);
		assert.ok(performance.now() - started < 50, "wildcard matching must remain bounded");
	});

	it("fails closed when rule or path caps are exceeded", () => {
		const tooManyWildcards = parseRobots(`User-agent: *\nDisallow: /${"*".repeat(65)}x\n`);
		assert.equal(tooManyWildcards.truncated, true);
		assert.equal(isRobotsAllowed(tooManyWildcards, "https://example.com/public"), false);

		const tooLongPattern = parseRobots(`User-agent: *\nDisallow: /${"x".repeat(2_048)}\n`);
		assert.equal(tooLongPattern.truncated, true);
		assert.equal(isRobotsAllowed(tooLongPattern, "https://example.com/public"), false);
		assert.equal(isRobotsAllowed(parseRobots("User-agent: *\nAllow: /\n"), `https://example.com/${"x".repeat(8_192)}`), false);
	});

	it("fails closed when rule or group caps omit later directives", () => {
		const ruleCapped = parseRobots("User-agent: *\nAllow: /safe\nDisallow: /\n", undefined, { maxRules: 1 });
		assert.equal(ruleCapped.truncated, true);
		assert.equal(isRobotsAllowed(ruleCapped, "https://example.com/secret"), false);

		const groupCapped = parseRobots("User-agent: OtherBot\nAllow: /\nUser-agent: *\nDisallow: /\n", undefined, { maxGroups: 1 });
		assert.equal(groupCapped.truncated, true);
		assert.equal(isRobotsAllowed(groupCapped, "https://example.com/secret"), false);
	});

	it("bounds total matching work across many hostile rules", () => {
		const hostile = {
			groups: [{
				userAgents: ["*"],
				rules: Array.from({ length: 20_000 }, (_, index) => ({ allow: true, pattern: `/${"*a".repeat(6)}z${index}` })),
				crawlDelay: null,
			}],
			sitemaps: [],
			truncated: false,
		};
		const started = performance.now();
		assert.equal(isRobotsAllowed(hostile, `https://example.com/${"a".repeat(8_000)}`), false);
		assert.ok(performance.now() - started < 250, "robots matching work must have a per-check ceiling");
	});

	it("bounds oversized input and ignores malformed records", () => {
		const oversized = parseRobots(`User-agent: *\nDisallow: /x\n${"# filler\n".repeat(100)}`, undefined, { maxChars: 40 });
		assert.equal(oversized.truncated, true);
		assert.equal(isRobotsAllowed(oversized, "https://example.com/x", "AnyBot"), false);
	});
});
