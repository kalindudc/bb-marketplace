import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { applyPublishedConfig, resolveComposerConfig } from "./src/config.ts";
import { extract, summaryHash } from "./src/extract.ts";
import { emptyLedger, ledgerPath, mergeLedger, readLedger, writeLedger, writeSummary } from "./src/ledger.ts";
import {
  assembleSummary,
  buildSummaryPrompt,
  estimateTokens,
  parseResume,
  truncateConversation,
} from "./src/prompt.ts";
import type { AnyMessage, Ledger, LedgerHistoryRow } from "./src/types.ts";

const LOG_MAX_BYTES = 256_000;

function log(cwd: string, event: string, detail: Record<string, unknown>): void {
  try {
    const dir = join(cwd, ".bb", "press");
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`;
    const path = join(dir, "composer.log");
    appendFileSync(path, line, "utf8");
  } catch {
    // Logging must never break compaction.
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    if (!ctx.hasUI) return;
    ctx.ui.notify(message, level);
  } catch {
    // The UI may be gone by the time a compaction finishes.
  }
}

/** A reasoning model can spend the whole output budget on thinking and return no
 * text, so the budget is generous and a retry doubles it. */
function summariserOptions(maxTokens: number, signal: AbortSignal): Record<string, unknown> {
  return {
    maxTokens,
    signal,
    cacheRetention: "none",
    sessionId: randomUUID(),
  };
}

function resolveModel(ctx: ExtensionContext, spec: string | null) {
  if (!spec) return ctx.model;
  const slash = spec.indexOf("/");
  if (slash <= 0) return ctx.model;
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  return ctx.modelRegistry.find(provider, modelId) ?? ctx.model;
}

function textOf(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim();
}

function recordCompaction(
  cwd: string,
  threadId: string | null,
  ledger: Ledger,
  row: LedgerHistoryRow,
  resume = ledger.resume,
): Ledger {
  const next: Ledger = {
    ...ledger,
    threadId: ledger.threadId ?? threadId,
    compactions: ledger.compactions + 1,
    resume: resume ?? ledger.resume,
    history: [...ledger.history, row].slice(-50),
  };
  writeLedger(ledgerPath(cwd), next);
  return next;
}

export default function pressComposer(pi: ExtensionAPI): void {
  // pi does not let an extension take over a built-in command name: a command called
  // "compact" is dropped from autocomplete and the built-in wins. So Press owns the
  // deliberate path under its own name, and every compaction, /compact included, still
  // runs through the hook below and is written by Press.
  pi.registerCommand("press", {
    description: "Compact this thread through Press, optionally with a focus",
    getArgumentCompletions: () => null,
    handler: async (args, ctx) => {
      const cwd = process.cwd();
      const config = resolveComposerConfig(cwd);
      if (!config.enabled) {
        notify(ctx, "Press is disabled for this workspace (providers.pi.enabled is false).", "warning");
        return;
      }
      const focus = args.trim();
      try {
        // pi's compact() aborts the current operation itself; waiting first can outlive
        // a session replacement and leave a stale context behind.
        ctx.compact({
          ...(focus ? { customInstructions: focus } : {}),
          onComplete: (result) => {
            log(cwd, "command-compacted", {
              tokensBefore: (result as { tokensBefore?: number }).tokensBefore ?? null,
              focus: focus || null,
            });
            notify(ctx, "Press compacted this thread.", "info");
          },
          onError: (error) => {
            log(cwd, "command-failed", { error: error.message });
            notify(ctx, `Press could not compact: ${error.message}`, "error");
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(cwd, "command-failed", { error: message });
        notify(ctx, `Press could not compact: ${message}`, "error");
      }
    },
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cwd = process.cwd();
    const config = resolveComposerConfig(cwd);
    if (!config.enabled) {
      log(cwd, "disabled", {});
      return;
    }

    const started = Date.now();
    const { preparation, customInstructions, reason, signal } = event;
    const messages = [
      ...(preparation.messagesToSummarize as AnyMessage[]),
      ...(preparation.turnPrefixMessages as AnyMessage[]),
    ] as AnyMessage[];

    let ledger: Ledger;
    try {
      const existing = readLedger(ledgerPath(cwd));
      // The governor publishes the resolved composer settings here; they win over the files.
      const published = applyPublishedConfig(config, existing?.composer);
      Object.assign(config, published);
      ledger = mergeLedger(existing, extract(messages, { threadId: process.env.BB_THREAD_ID ?? null }));
      // Persist before the model call: a failed or empty summary must not lose the
      // constraints, and the next compaction's span may no longer contain them.
      writeLedger(ledgerPath(cwd), ledger);
    } catch {
      ledger = emptyLedger(process.env.BB_THREAD_ID ?? null);
    }

    try {
      const model = resolveModel(ctx, config.model);
      if (!model) {
        log(cwd, "no-model", { reason });
        return;
      }

      const serialised = serializeConversation(
        convertToLlm(messages as unknown as Parameters<typeof convertToLlm>[0]),
      );
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

      notify(
        ctx,
        `Press: summarising ${Math.round(preparation.tokensBefore / 1000)}k tokens with ${model.id}` +
          (bounded.truncated ? ` (dropped ${bounded.droppedChars} chars that did not fit)` : ""),
        "info",
      );

      let summaryResponse = await ctx.modelRegistry.complete(
        model,
        {
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        summariserOptions(config.maxSummaryTokens, signal),
      );

      let narrativeText = textOf(summaryResponse as { content: Array<{ type: string; text?: string }> });
      if (!narrativeText) {
        // A reasoning model can spend the whole budget on thinking and return no text.
        const stopReason = (summaryResponse as { stopReason?: string }).stopReason ?? null;
        log(cwd, "empty-summary", { reason, model: model.id, stopReason, retrying: true });
        const retry = await ctx.modelRegistry.complete(
          model,
          {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: prompt }],
                timestamp: Date.now(),
              },
            ],
          },
          summariserOptions(Math.min(config.maxSummaryTokens * 4, 12_000), signal),
        );
        summaryResponse = retry;
        narrativeText = textOf(retry as { content: Array<{ type: string; text?: string }> });
        if (!narrativeText) {
          log(cwd, "empty-summary", { reason, model: model.id, retried: true });
          return;
        }
      }

      const parsed = parseResume(narrativeText);
      const summary = assembleSummary({
        narrative: parsed.narrative,
        resume: parsed.resume,
        ledger,
        config,
        threadId: ledger.threadId ?? process.env.BB_THREAD_ID ?? null,
        tokensBefore: preparation.tokensBefore,
      });

      const id = `press-${Date.now().toString(36)}`;
      let summaryPath: string | null = null;
      try {
        summaryPath = writeSummary(cwd, id, summary);
      } catch (error) {
        log(cwd, "summary-write-failed", { error: error instanceof Error ? error.message : String(error) });
      }

      recordCompaction(
        cwd,
        process.env.BB_THREAD_ID ?? null,
        ledger,
        {
          id,
          at: new Date().toISOString(),
          point: reason === "manual" ? "manual" : reason,
          tokensBefore: preparation.tokensBefore,
          tokensAfter: estimateTokens(summary),
          model: `${model.provider}/${model.id}`,
          ms: Date.now() - started,
          keptTurns: null,
          summaryHash: summaryHash(summary),
          summaryPath,
          preview: summary
            .replace(/^#.*$/gm, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 180),
          outcome: "ok",
        },
        parsed.resume ?? ledger.resume,
      );

      log(cwd, "compacted", {
        reason,
        model: `${model.provider}/${model.id}`,
        tokensBefore: preparation.tokensBefore,
        summaryTokens: estimateTokens(summary),
        truncated: bounded.truncated,
        ms: Date.now() - started,
      });

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage: summaryResponse.usage,
          details: { press: { ledger: true, model: model.id, truncated: bounded.truncated } },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(cwd, "failed", { reason, error: message });
      notify(ctx, `Press: falling back to pi's own summary (${message})`, "warning");
      return;
    }
  });

  pi.on("session_compact", async (event, ctx) => {
    const cwd = process.cwd();
    const fromExtension = (event as { fromExtension?: boolean }).fromExtension === true;
    log(cwd, "session_compact", {
      reason: (event as { reason?: string }).reason ?? null,
      fromExtension,
    });
    void ctx;
  });

  pi.on("session_compact_failed", async (event, ctx) => {
    const cwd = process.cwd();
    log(cwd, "session_compact_failed", {
      reason: (event as { reason?: string }).reason ?? null,
      aborted: (event as { aborted?: boolean }).aborted ?? null,
      errorMessage: (event as { errorMessage?: string }).errorMessage ?? null,
    });
    void ctx;
  });
}

export const PRESS_COMPOSER_LOG_MAX_BYTES = LOG_MAX_BYTES;
