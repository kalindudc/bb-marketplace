import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { parseSummaryModel, resolveThreadComposerConfig } from "./src/config.ts";
import { extract, userGoal } from "./src/extract.ts";
import { ledgerPath } from "./src/ledger-format.ts";
import { mergeLedger, nodeLedgerIo, pruneSummaries, readLedger, writeLedger, writeSummary } from "./src/ledger.ts";
import { assembleSummary, buildSummaryPrompt, parseResume, truncateConversation } from "./src/prompt.ts";
import type { AnyMessage, ComposerRow, Ledger } from "./src/types.ts";

export const PRESS_COMPOSER_LOG_MAX_BYTES = 256_000;
const INSTANCE_CHANNEL = "press-composer:instance";

function log(cwd: string, event: string, detail: Record<string, unknown>): void {
  try {
    const dir = join(cwd, ".bb", "press");
    mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    let line = `${JSON.stringify({ at, event, ...detail })}\n`;
    const path = join(dir, "composer.log");
    if (Buffer.byteLength(line) > PRESS_COMPOSER_LOG_MAX_BYTES) {
      line = `${JSON.stringify({ at, event, detail: "Log detail exceeded the byte limit" })}\n`;
    }
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > PRESS_COMPOSER_LOG_MAX_BYTES) {
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Logging must never break compaction.
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    // The UI may be gone by the time a compaction finishes.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Prepared {
  started: number;
  ledger: Ledger;
  cwd: string;
  path: string;
  summary?: { id: string; model: string; resume: Ledger["resume"] };
}

export default function pressComposer(pi: ExtensionAPI): void {
  const threadId = process.env.BB_THREAD_ID;
  if (!threadId) return;

  // Pi disposes event subscriptions on reload; a process-wide flag could disable the new copy.
  const claim = { registered: false };
  pi.events.emit(INSTANCE_CHANNEL, claim);
  if (claim.registered) return;
  pi.events.on(INSTANCE_CHANNEL, (request) => {
    if (request && typeof request === "object" && "registered" in request) request.registered = true;
  });

  let pending: Prepared | undefined;
  const warnedModels = new Set<string>();

  // Pi reserves /compact; /press gives the same hook a dedicated command with an optional focus.
  pi.registerCommand("press", {
    description: "Compact this thread through Press, optionally with a focus",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const config = resolveThreadComposerConfig(cwd, threadId);
      if (!config.enabled) {
        notify(ctx, "Press is disabled for this workspace (providers.pi.enabled is false).", "warning");
        return;
      }
      const focus = args.trim();
      const failed = (error: unknown) => {
        const message = errorText(error);
        log(cwd, "command-failed", { error: message });
        notify(ctx, `Press could not compact: ${message}`, "error");
      };
      try {
        // Pi aborts ongoing work itself, so waiting could leave a stale context after a session switch.
        ctx.compact({
          ...(focus ? { customInstructions: focus } : {}),
          onComplete: (result) => {
            log(cwd, "command-compacted", { tokensBefore: result.tokensBefore, focus: focus || null });
            notify(ctx, "Press compacted this thread.", "info");
          },
          onError: failed,
        });
      } catch (error) {
        failed(error);
      }
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    pending = undefined;
    const cwd = ctx.cwd;
    const started = Date.now();
    const { preparation, customInstructions, reason, signal } = event;
    if (signal.aborted) return;

    try {
      const config = resolveThreadComposerConfig(cwd, threadId);
      if (!config.enabled) {
        log(cwd, "disabled", {});
        return;
      }
      const path = ledgerPath(cwd, threadId);
      const existing = await readLedger(nodeLedgerIo, path);
      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      const extracted = extract(messages as AnyMessage[], { threadId, previousFailures: existing?.state.testFailures });
      if (!existing?.state.goal) {
        for (const entry of event.branchEntries) {
          if (entry.type !== "message" || entry.message.role !== "user") continue;
          const goal = userGoal(entry.message.content);
          if (goal === null) continue;
          extracted.state.goal = goal;
          break;
        }
      }
      const ledger = mergeLedger(existing, extracted);
      const prepared: Prepared = { started, ledger, cwd, path };
      pending = prepared;

      const spec = config.model === null ? null : parseSummaryModel(config.model);
      const configured = spec ? ctx.modelRegistry.find(spec.provider, spec.modelId) : undefined;
      if (config.model !== null && !configured) {
        log(cwd, "model-not-found", {
          reason, requested: config.model, problem: spec ? "not-found" : "invalid-spec", fallback: ctx.model?.id ?? null,
        });
        if (!warnedModels.has(config.model)) {
          warnedModels.add(config.model);
          const problem = spec ? "was not found" : "must use provider/modelId";
          notify(ctx, `Press: summary model ${JSON.stringify(config.model)} ${problem}; using the thread model if available.`, "warning");
        }
      }
      const model = configured ?? ctx.model;
      if (!model) {
        log(cwd, "no-model", { reason });
        return;
      }
      const serialised = serializeConversation(convertToLlm(messages));
      const maxChars = Math.max(20_000, Math.floor(model.contextWindow * config.inputBudgetRatio * 4));
      const bounded = truncateConversation(serialised, maxChars);
      const prompt = buildSummaryPrompt({
        conversationText: bounded.text,
        previousSummary: preparation.previousSummary,
        ledger,
        customInstructions,
        maxSummaryTokens: config.maxSummaryTokens,
        resumeContract: config.resumeContract,
      });

      notify(ctx,
        `Press: summarising ${Math.round(preparation.tokensBefore / 1000)}k tokens with ${model.id}` +
          (bounded.truncated ? ` (dropped ${bounded.droppedChars} chars that did not fit)` : ""),
        "info",
      );

      const summarise = async (maxTokens: number) => {
        signal.throwIfAborted();
        const response = await ctx.modelRegistry.complete(model, {
          messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
        }, { maxTokens, signal, cacheRetention: "none", sessionId: randomUUID() });
        signal.throwIfAborted();
        const text = response.stopReason === "stop"
          ? response.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n").trim()
          : "";
        return { text, usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage };
      };

      const budget = Math.min(model.maxTokens, Math.max(config.maxSummaryTokens * 2, 8_000));
      const retryBudget = Math.min(model.maxTokens, budget * 2);
      let response = await summarise(budget);
      const retryReason = response.stopReason === "length" ? "summary-length"
        : response.stopReason === "stop" && !response.text ? "empty-summary" : null;
      if (retryReason && retryBudget > budget) {
        log(cwd, retryReason, { reason, model: model.id, errorMessage: response.errorMessage, retrying: true });
        response = await summarise(retryBudget);
      }
      if (response.stopReason !== "stop") {
        throw new Error(`Summary stopped with ${response.stopReason}${response.errorMessage ? `: ${response.errorMessage}` : ""}`);
      }
      if (!response.text) throw new Error("Summary returned no text");

      const parsed = parseResume(response.text);
      const summary = assembleSummary({
        narrative: parsed.narrative,
        resume: parsed.resume,
        ledger,
        config,
        threadId,
        tokensBefore: preparation.tokensBefore,
      });
      const id = `press-${randomUUID()}`;
      prepared.summary = { id, model: `${model.provider}/${model.id}`, resume: parsed.resume };
      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: response.usage,
          details: { press: { id, ledger: config.ledger, model: model.id, truncated: bounded.truncated } },
        },
      };
    } catch (error) {
      const message = errorText(error);
      log(cwd, "failed", { reason, error: message });
      notify(ctx, `Press: falling back to pi's own summary (${message})`, "warning");
      return;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const prepared = pending;
    pending = undefined;
    if (!prepared) return;
    // Pi can emit an earlier entry when two summaries have identical text.
    const leaf = ctx.sessionManager.getLeafEntry();
    const entry = leaf?.type === "compaction" ? leaf : event.compactionEntry;
    const details = entry.details as { press?: { id?: unknown } } | undefined;
    const { cwd, path, ledger, started, summary } = prepared;
    const savedAt = Date.parse(entry.timestamp);
    const finishedAt = Number.isFinite(savedAt) ? savedAt : Date.now();
    const next: Ledger = { ...ledger, updatedAt: new Date(finishedAt).toISOString() };
    let row: ComposerRow | undefined;
    if (event.fromExtension && summary && details?.press?.id === summary.id) {
      row = {
        id: summary.id, at: new Date(started).toISOString(), finishedAt, point: event.reason,
        tokensBefore: entry.tokensBefore, tokensAfter: null,
        model: summary.model, ms: Date.now() - started, summaryPath: null, outcome: "ok",
      };
      try {
        row.summaryPath = await writeSummary(cwd, threadId, row.id, entry.summary);
      } catch (error) {
        log(cwd, "summary-write-failed", { error: errorText(error) });
      }
      next.resume = summary.resume ?? ledger.resume;
      next.compactions += 1;
      next.history = [...ledger.history, row];
    }
    let saved: Ledger;
    try {
      saved = await writeLedger(nodeLedgerIo, path, next);
    } catch (error) {
      log(cwd, "ledger-write-failed", { error: errorText(error) });
      if (row) await pruneSummaries(cwd, threadId, [row], []).catch((cleanup) => {
        log(cwd, "summary-prune-failed", { error: errorText(cleanup) });
      });
      return;
    }
    await pruneSummaries(cwd, threadId, next.history, saved.history).catch((error) => {
      log(cwd, "summary-prune-failed", { error: errorText(error) });
    });
    if (row) log(cwd, "compacted", {
      id: row.id, reason: event.reason, model: row.model, tokensBefore: row.tokensBefore, tokensAfter: row.tokensAfter, ms: row.ms,
    });
  });

  pi.on("session_compact_failed", (event, ctx) => {
    pending = undefined;
    log(ctx.cwd, "session_compact_failed", { reason: event.reason, aborted: event.aborted, errorMessage: event.errorMessage });
  });
}
