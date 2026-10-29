import { createHash } from "node:crypto";
import type { DiffHunk, DiffOptions, SnapshotDiff, SnapshotDocument } from "./model.ts";

const DEFAULT_MAX_BLOCKS = 20_000;
const DEFAULT_MAX_HUNKS = 200;
const DEFAULT_MAX_CHARS = 100_000;

interface Block {
	text: string;
	startLine: number;
	endLine: number;
	headingPath: string[];
	hash: string;
}

function digest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function check(options: DiffOptions): void {
	if (options.signal?.aborted) throw new Error("Snapshot diff was cancelled.");
	if (options.deadlineAt !== undefined && (options.now ?? Date.now)() > options.deadlineAt) throw new Error("Snapshot diff timed out.");
}

function validateBound(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer.`);
	return resolved;
}

function blocks(content: string, options: DiffOptions, limit: number): Block[] {
	const lines = content.replace(/\r\n?/gu, "\n").split("\n");
	const result: Block[] = [];
	const headingPath: string[] = [];
	let index = 0;
	while (index < lines.length) {
		if ((index & 255) === 0) check(options);
		const line = lines[index]!;
		if (line.trim() === "") {
			index += 1;
			continue;
		}
		const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			headingPath.splice(level - 1);
			headingPath.push(heading[2]!.trim());
			result.push({ text: line, startLine: index + 1, endLine: index + 1, headingPath: headingPath.slice(0, -1), hash: digest(line) });
			if (result.length > limit) return result;
			index += 1;
			continue;
		}
		const start = index;
		let end = index;
		if (/^\s*```/u.test(line)) {
			end += 1;
			while (end < lines.length && !/^\s*```/u.test(lines[end]!)) {
				if ((end & 255) === 0) check(options);
				end += 1;
			}
			if (end < lines.length) end += 1;
		} else if (/^\s*\|/u.test(line)) {
			end += 1;
			while (end < lines.length && /^\s*\|/u.test(lines[end]!)) {
				if ((end & 255) === 0) check(options);
				end += 1;
			}
		} else {
			end += 1;
			while (end < lines.length && lines[end]!.trim() !== "" && !/^(#{1,6})\s+/u.test(lines[end]!)) {
				if ((end & 255) === 0) check(options);
				end += 1;
			}
		}
		const text = lines.slice(start, end).join("\n");
		result.push({ text, startLine: start + 1, endLine: end, headingPath: [...headingPath], hash: digest(text) });
		if (result.length > limit) return result;
		index = end;
	}
	return result;
}

function summary(content: string, values: readonly Block[]) {
	const window = 64 * 1024;
	return {
		blocks: values.length,
		prefixHash: digest(content.slice(0, window)),
		suffixHash: digest(content.slice(Math.max(0, content.length - window))),
	};
}

function uniqueAnchors(before: readonly Block[], after: readonly Block[], options: DiffOptions): Array<[number, number]> {
	const positions = (values: readonly Block[]) => {
		const result = new Map<string, { count: number; index: number }>();
		for (let index = 0; index < values.length; index += 1) {
			if ((index & 255) === 0) check(options);
			const block = values[index]!;
			const current = result.get(block.hash);
			if (current) current.count += 1;
			else result.set(block.hash, { count: 1, index });
		}
		return result;
	};
	const beforePositions = positions(before);
	const afterPositions = positions(after);
	const pairs: Array<[number, number]> = [];
	for (const [hash, position] of beforePositions) {
		check(options);
		const other = afterPositions.get(hash);
		if (position.count === 1 && other?.count === 1) pairs.push([position.index, other.index]);
	}
	pairs.sort((left, right) => left[0] - right[0]);
	const tails: number[] = [];
	const tailIndices: number[] = [];
	const previous = new Array<number>(pairs.length).fill(-1);
	for (let index = 0; index < pairs.length; index += 1) {
		const value = pairs[index]![1];
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (tails[middle]! < value) low = middle + 1;
			else high = middle;
		}
		if (low > 0) previous[index] = tailIndices[low - 1]!;
		tails[low] = value;
		tailIndices[low] = index;
	}
	const result: Array<[number, number]> = [];
	let cursor = tailIndices.at(-1) ?? -1;
	while (cursor >= 0) {
		result.push(pairs[cursor]!);
		cursor = previous[cursor]!;
	}
	return result.reverse();
}

function range(block: Block | undefined): DiffHunk["before"] {
	return block ? { startLine: block.startLine, endLine: block.endLine, text: block.text } : null;
}

const MAX_LCS_CELLS = 250_000;

function segmentMatches(before: readonly Block[], after: readonly Block[], options: DiffOptions): Array<[number, number]> {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix]!.hash === after[prefix]!.hash) prefix += 1;
	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > prefix && afterEnd > prefix && before[beforeEnd - 1]!.hash === after[afterEnd - 1]!.hash) {
		beforeEnd -= 1;
		afterEnd -= 1;
	}
	const matches: Array<[number, number]> = Array.from({ length: prefix }, (_, index) => [index, index]);
	const beforeLength = beforeEnd - prefix;
	const afterLength = afterEnd - prefix;
	if (beforeLength > 0 && afterLength > 0 && beforeLength * afterLength <= MAX_LCS_CELLS) {
		const width = afterLength + 1;
		const table = new Uint32Array((beforeLength + 1) * width);
		for (let left = beforeLength - 1; left >= 0; left -= 1) {
			if ((left & 63) === 0) check(options);
			for (let right = afterLength - 1; right >= 0; right -= 1) {
				const offset = left * width + right;
				table[offset] = before[prefix + left]!.hash === after[prefix + right]!.hash
					? table[(left + 1) * width + right + 1]! + 1
					: Math.max(table[(left + 1) * width + right]!, table[offset + 1]!);
			}
		}
		let left = 0;
		let right = 0;
		while (left < beforeLength && right < afterLength) {
			if (before[prefix + left]!.hash === after[prefix + right]!.hash) {
				matches.push([prefix + left, prefix + right]);
				left += 1;
				right += 1;
			} else if (table[(left + 1) * width + right]! >= table[left * width + right + 1]!) left += 1;
			else right += 1;
		}
	} else if (beforeLength > 0 && afterLength > 0) {
		const positions = new Map<string, number[]>();
		for (let index = prefix; index < afterEnd; index += 1) {
			const values = positions.get(after[index]!.hash);
			if (values) values.push(index);
			else positions.set(after[index]!.hash, [index]);
		}
		let previous = prefix - 1;
		for (let index = prefix; index < beforeEnd; index += 1) {
			if ((index & 255) === 0) check(options);
			const values = positions.get(before[index]!.hash);
			if (!values) continue;
			let low = 0;
			let high = values.length;
			while (low < high) {
				const middle = (low + high) >>> 1;
				if (values[middle]! <= previous) low = middle + 1;
				else high = middle;
			}
			if (low < values.length) {
				previous = values[low]!;
				matches.push([index, previous]);
			}
		}
	}
	for (let offset = 0; offset < before.length - beforeEnd; offset += 1) matches.push([beforeEnd + offset, afterEnd + offset]);
	return matches;
}

function appendChanged(hunks: DiffHunk[], before: readonly Block[], after: readonly Block[]): void {
	const count = Math.max(before.length, after.length);
	for (let index = 0; index < count; index += 1) {
		const left = before[index];
		const right = after[index];
		if (left && right && left.hash === right.hash) continue;
		hunks.push({
			kind: left && right ? "changed" : left ? "removed" : "added",
			headingPath: [...(right?.headingPath ?? left?.headingPath ?? [])],
			before: range(left),
			after: range(right),
		});
	}
}

function changedSegments(before: readonly Block[], after: readonly Block[], anchors: readonly [number, number][], options: DiffOptions): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let beforeStart = 0;
	let afterStart = 0;
	for (const [beforeAnchor, afterAnchor] of [...anchors, [before.length, after.length] as [number, number]]) {
		const beforeSegment = before.slice(beforeStart, beforeAnchor);
		const afterSegment = after.slice(afterStart, afterAnchor);
		let beforeMatchStart = 0;
		let afterMatchStart = 0;
		for (const [beforeMatch, afterMatch] of [...segmentMatches(beforeSegment, afterSegment, options), [beforeSegment.length, afterSegment.length] as [number, number]]) {
			appendChanged(hunks, beforeSegment.slice(beforeMatchStart, beforeMatch), afterSegment.slice(afterMatchStart, afterMatch));
			beforeMatchStart = beforeMatch + 1;
			afterMatchStart = afterMatch + 1;
		}
		beforeStart = beforeAnchor + 1;
		afterStart = afterAnchor + 1;
	}
	return hunks;
}

function lineCount(value: DiffHunk["before"]): number {
	return value ? value.endLine - value.startLine + 1 : 0;
}

function boundHunks(values: readonly DiffHunk[], maxHunks: number, maxChars: number): { hunks: DiffHunk[]; truncated: boolean } {
	const hunks: DiffHunk[] = [];
	let remaining = maxChars;
	let truncated = values.length > maxHunks;
	for (const value of values.slice(0, maxHunks)) {
		const copy: DiffHunk = { ...value, headingPath: [...value.headingPath], before: value.before ? { ...value.before } : null, after: value.after ? { ...value.after } : null };
		for (const side of ["before", "after"] as const) {
			const item = copy[side];
			if (!item) continue;
			if (item.text.length > remaining) {
				item.text = item.text.slice(0, remaining);
				truncated = true;
			}
			remaining -= item.text.length;
		}
		hunks.push(copy);
		if (remaining === 0 && hunks.length < values.length) {
			truncated = true;
			break;
		}
	}
	return { hunks, truncated };
}

export function diffSnapshots(beforeDocument: SnapshotDocument, afterDocument: SnapshotDocument, options: DiffOptions = {}): SnapshotDiff {
	const maxBlocks = validateBound(options.maxBlocks, DEFAULT_MAX_BLOCKS, "maxBlocks");
	const maxHunks = validateBound(options.maxHunks, DEFAULT_MAX_HUNKS, "maxHunks");
	const maxChars = validateBound(options.maxChars, DEFAULT_MAX_CHARS, "maxChars");
	check(options);
	const allBefore = blocks(beforeDocument.content, options, maxBlocks);
	const allAfter = blocks(afterDocument.content, options, maxBlocks);
	const blockLimited = allBefore.length > maxBlocks || allAfter.length > maxBlocks;
	const before = allBefore.slice(0, maxBlocks);
	const after = allAfter.slice(0, maxBlocks);
	const anchors = uniqueAnchors(before, after, options);
	const rawHunks = changedSegments(before, after, anchors, options);
	const bounded = boundHunks(rawHunks, maxHunks, maxChars);
	const extractorChanged = beforeDocument.extractorId !== afterDocument.extractorId || beforeDocument.extractorVersion !== afterDocument.extractorVersion;
	const warnings: string[] = [];
	if (extractorChanged) warnings.push("Extractor changes may contribute to this diff.");
	if (blockLimited) warnings.push(`Block limit reached; compared ${before.length} before blocks and ${after.length} after blocks.`);
	if (bounded.truncated) warnings.push("Diff output was truncated by its hunk or character limit.");
	const result: SnapshotDiff = {
		beforeSnapshotId: beforeDocument.id,
		afterSnapshotId: afterDocument.id,
		unchanged: rawHunks.length === 0 && !blockLimited,
		extractorChanged,
		hunks: bounded.hunks,
		addedLines: rawHunks.reduce((total, hunk) => total + lineCount(hunk.after), 0),
		removedLines: rawHunks.reduce((total, hunk) => total + lineCount(hunk.before), 0),
		truncated: blockLimited || bounded.truncated,
		warnings,
	};
	if (blockLimited) result.blockSummary = { before: summary(beforeDocument.content, allBefore), after: summary(afterDocument.content, allAfter) };
	return result;
}
