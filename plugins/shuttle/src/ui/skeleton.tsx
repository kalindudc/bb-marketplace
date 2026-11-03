import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { ICON_GHOST } from "./common";

/** A grey shape where a word, a chip or an avatar will be; the caller gives its size and its corners. */
function Bone({ className }: { className: string }) {
  return <span className={`block animate-pulse bg-surface-recessed ${className}`} />;
}

const TITLES = ["w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-5/12", "w-7/12"] as const;
const FACTS = ["w-2/5", "w-1/4", "w-1/3", "w-1/2", "w-1/4", "w-1/3"] as const;
const LINES = ["w-full", "w-11/12", "w-4/5", "w-2/3"] as const;
const width = (widths: readonly string[], index: number) => widths[index % widths.length]!;
const times = (count: number) => Array.from({ length: count }, (_, index) => index);

/**
 * Stands where a list, a PR or a tab will be until Shuttle's server answers, and names what is loading for a screen
 * reader. It fades in after a moment, so an answer that comes at once never flashes it.
 */
function Loading({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  // bb's delay-150 is a transition delay; animate-in reads its delay from this property.
  return (
    <div role="status" aria-label={label} data-skeleton className={`animate-in fade-in fill-mode-both duration-300 [--tw-animation-delay:150ms] ${className}`}>
      {children}
    </div>
  );
}

/** The Inbox's rows: who, the repository and title, a line of facts, and the age. */
export function InboxSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <Loading label={label} className="mt-3">
      <Bone className="mb-2 h-3 w-24 rounded-sm" />
      <ul className="overflow-hidden rounded-lg border border-border bg-card">
        {times(rows).map((index) => (
          <li key={index} className="grid min-h-11 grid-cols-[16px_28px_minmax(0,1fr)_auto] items-center gap-x-2.5 border-t border-border py-2 pl-2.5 pr-3 first:border-t-0">
            <span />
            <Bone className="size-7 rounded-full" />
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex min-w-0 items-center gap-2">
                <Bone className="h-4 w-20 shrink-0 rounded-md" />
                <Bone className={`h-3.5 min-w-0 rounded-sm ${width(TITLES, index)}`} />
              </div>
              <Bone className={`h-3 rounded-sm ${width(FACTS, index)}`} />
            </div>
            <Bone className="h-3 w-6 rounded-sm" />
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/** My PRs', Reviews' and a board's rows: the key, the title and the pills under it. */
export function PrListSkeleton({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <Loading label={label} className="mt-4">
      <Bone className="mb-2 h-3 w-28 rounded-sm" />
      <ul className="overflow-hidden rounded-lg border border-border bg-card">
        {times(rows).map((index) => (
          <li key={index} className="border-t border-border px-3.5 py-2.5 first:border-t-0">
            <Bone className="h-3 w-36 rounded-sm" />
            <Bone className={`mb-2 mt-1.5 h-3.5 rounded-sm ${width(TITLES, index)}`} />
            <div className="flex gap-1">
              <Bone className="h-5 w-16 rounded-full" />
              <Bone className="h-5 w-20 rounded-full" />
              <Bone className="h-5 w-14 rounded-full" />
            </div>
          </li>
        ))}
      </ul>
    </Loading>
  );
}

/** One line each, as in the Automation log, a PR's commits and files, or each server under Sync. */
export function LinesSkeleton({ label, rows = 6 }: { label: string; rows?: number }) {
  return (
    <Loading label={label}>
      <ul className="overflow-hidden rounded-lg border border-border bg-card">
        {times(rows).map((index) => (
          <li key={index} className="flex items-center gap-2.5 border-t border-border px-3 py-2.5 first:border-t-0">
            <Bone className="size-3.5 shrink-0 rounded-full" />
            <Bone className={`h-3 min-w-0 rounded-sm ${width(TITLES, index)}`} />
            <span className="flex-1" />
            <Bone className="h-3 w-12 shrink-0 rounded-sm" />
          </li>
        ))}
      </ul>
    </Loading>
  );
}

export function BoardsSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @5xl:grid-cols-3">
      {times(3).map((index) => (
        <div key={index} className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-4 @xl:min-h-56">
          <div className="flex items-start gap-2">
            <Bone className="size-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1 pt-0.5">
              <Bone className={`h-3.5 rounded-sm ${width(TITLES, index + 1)}`} />
              <Bone className="mt-1.5 h-3 w-4/5 rounded-sm" />
            </div>
          </div>
          <div className="mt-3 flex-1 space-y-1.5">
            {times(3).map((row) => <Bone key={row} className="h-7 w-full rounded-md" />)}
          </div>
          <div className="mt-3 border-t border-border pt-2"><Bone className="h-3 w-16 rounded-sm" /></div>
        </div>
      ))}
    </Loading>
  );
}

/** Insights' four figures and two of its panels. */
export function InsightsSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label}>
      <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4">
        {times(4).map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card px-3 py-2.5">
            <Bone className="h-3 w-24 max-w-full rounded-sm" />
            <Bone className="mt-1.5 h-6 w-14 rounded-sm" />
            <Bone className="mt-1.5 h-3 w-20 max-w-full rounded-sm" />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 @4xl:grid-cols-2">
        {times(2).map((index) => (
          <div key={index} className="rounded-lg border border-border bg-card px-3.5 py-3">
            <Bone className="h-3.5 w-48 max-w-full rounded-sm" />
            <Bone className="mt-1.5 h-3 w-36 max-w-full rounded-sm" />
            <Bone className="mt-3.5 h-3 w-full rounded-full" />
            <div className="mt-2.5 flex gap-3">
              {times(3).map((part) => <Bone key={part} className="h-3 w-16 rounded-sm" />)}
            </div>
          </div>
        ))}
      </div>
    </Loading>
  );
}

function TextBones() {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card px-3.5 py-3">
      {LINES.map((line) => <Bone key={line} className={`h-3 rounded-sm ${line}`} />)}
    </div>
  );
}

/** A PR's description, until its server sends it. */
export function TextSkeleton({ label }: { label: string }) {
  return <Loading label={label}><TextBones /></Loading>;
}

/** A PR's conversation: who said it, when, and what. */
export function ConversationSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className="space-y-4">
      {times(3).map((index) => (
        <div key={index} className="flex gap-2.5">
          <Bone className="size-[22px] shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex h-[22px] items-center gap-2">
              <Bone className="h-3 w-20 rounded-sm" />
              <Bone className="h-3 w-10 rounded-sm" />
            </div>
            <div className="mt-1 space-y-2 rounded-lg border border-border bg-card px-3 py-2.5">
              <Bone className="h-3 w-full rounded-sm" />
              <Bone className={`h-3 rounded-sm ${width(TITLES, index)}`} />
            </div>
          </div>
        </div>
      ))}
    </Loading>
  );
}

/**
 * A PR's view, from its title down to its tabs, until it lands. Close is a real button, so a PR that takes long can
 * still be put away.
 */
export function DetailSkeleton({ label, phone = false, onClose }: { label: string; phone?: boolean; onClose?: () => void }) {
  return (
    <div className="relative min-w-0 bg-background pb-10">
      {!phone && onClose && (
        <div className="absolute right-2 top-2 z-10">
          <button type="button" aria-label="Close details" title="Close" className={ICON_GHOST} onClick={onClose}>
            <Icon name="X" className="size-4" aria-hidden />
          </button>
        </div>
      )}
      <Loading label={label}>
        {!phone && (
          <div className="flex h-11 items-center gap-2 pl-4 pr-2">
            <Bone className="h-3 w-12 rounded-sm" />
            <Bone className="h-3 w-28 rounded-sm" />
          </div>
        )}
        <div className={`px-4 pb-3.5 ${phone ? "pt-4" : "pt-1"}`}>
          <Bone className="h-5 w-4/5 rounded-sm" />
          <Bone className="mt-1.5 h-5 w-1/2 rounded-sm" />
          <div className="mt-3 flex items-center gap-2">
            <Bone className="h-5 w-16 shrink-0 rounded-full" />
            <Bone className="size-[18px] shrink-0 rounded-full" />
            <Bone className="h-3 w-56 min-w-0 rounded-sm" />
          </div>
          <Bone className="mt-2 h-3 w-40 rounded-sm" />
        </div>
        <div className="px-4">
          <div className="space-y-3 rounded-lg border border-border bg-card p-3">
            {times(3).map((index) => (
              <div key={index} className="flex items-center gap-2.5">
                <Bone className="size-4 shrink-0 rounded-full" />
                <Bone className="h-3 w-16 shrink-0 rounded-sm" />
                <Bone className={`h-3 min-w-0 rounded-sm ${width(FACTS, index + 3)}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-4 flex gap-4 overflow-hidden border-b border-border px-4 pb-2.5">
          {["w-16", "w-24", "w-14", "w-16", "w-14"].map((tab, index) => <Bone key={index} className={`h-3.5 shrink-0 rounded-sm ${tab}`} />)}
        </div>
        <div className="px-4 pt-4">
          <Bone className="mb-2.5 h-3 w-24 rounded-sm" />
          <TextBones />
        </div>
      </Loading>
    </div>
  );
}

/** A linked PR's card in a thread's Shuttle tab. */
export function ThreadTabSkeleton({ label }: { label: string }) {
  return (
    <Loading label={label}>
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center gap-2">
          <Bone className="h-5 w-6 rounded-md" />
          <Bone className="h-3 w-28 rounded-sm" />
          <Bone className="h-5 w-12 rounded-full" />
        </div>
        <Bone className="mt-2.5 h-4 w-4/5 rounded-sm" />
        <div className="mt-2.5 flex gap-1">
          <Bone className="h-5 w-14 rounded-full" />
          <Bone className="h-5 w-20 rounded-full" />
          <Bone className="h-5 w-16 rounded-full" />
        </div>
        <div className="mt-3 flex gap-1.5">
          <Bone className="h-7 w-20 rounded-md" />
          <Bone className="h-7 w-16 rounded-md" />
          <Bone className="h-7 w-28 rounded-md" />
        </div>
      </div>
    </Loading>
  );
}
