import { useState } from "react";
import { Markdown, experimental_copyToClipboard, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { FlareDto } from "../contract";
import { ago } from "../format";
import { KIND_ICONS, KIND_LABELS } from "../kinds";
import { clock, flareMarkdown } from "./group";

const LONG_BODY = 600;

export function KindIcon({ kind, className }: { kind: FlareDto["kind"]; className?: string }) {
  return (
    <Icon
      name={KIND_ICONS[kind]}
      fallback="Zap"
      aria-hidden
      className={cn("size-4 shrink-0", kind === "blocker" ? "text-destructive" : "text-muted-foreground", className)}
    />
  );
}

export function ChildLink({ child }: { child: NonNullable<FlareDto["fromChild"]> }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      className="min-w-0 max-w-48 cursor-pointer truncate text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      title="Open the child thread"
      onClick={() => navigate.toThread(child.threadId)}
    >
      from {child.title ?? "a child thread"}
    </button>
  );
}

async function copy(flare: FlareDto): Promise<void> {
  const copied = await experimental_copyToClipboard({ text: flareMarkdown(flare, Date.now()) });
  if (copied) toast.success("Copied the flare");
  else toast.error("Could not copy the flare");
}

export function FlareCard({ flare, now }: { flare: FlareDto; now: number }) {
  const long = flare.body.length > LONG_BODY || flare.body.split("\n").length > 10;
  const [open, setOpen] = useState(false);
  return (
    <article
      data-flare-id={flare.id}
      className={cn(
        "group rounded-lg border border-border bg-card px-3 py-2 text-card-foreground",
        flare.kind === "blocker" && "border-l-2 border-l-destructive",
      )}
    >
      <header className="flex items-start gap-2">
        <KindIcon kind={flare.kind} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{flare.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span>{KIND_LABELS[flare.kind]}</span>
            <span aria-hidden>·</span>
            <time dateTime={new Date(flare.createdAt).toISOString()} title={clock(flare.createdAt, now)}>
              {ago(flare.createdAt, now)}
            </time>
            {flare.fromChild !== null && (
              <>
                <span aria-hidden>·</span>
                <ChildLink child={flare.fromChild} />
              </>
            )}
            {flare.pushed && (
              <>
                <span aria-hidden>·</span>
                <span>notified</span>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          aria-label="Copy this flare"
          title="Copy as Markdown"
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-state-hover hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => void copy(flare)}
        >
          <Icon name="Copy" className="size-3.5" aria-hidden />
        </button>
      </header>
      {flare.body !== "" && (
        <div className="mt-1.5 pl-6">
          <div className={cn("text-sm", long && !open && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]")}>
            <Markdown content={flare.body} />
          </div>
          {long && (
            <button type="button" className="mt-1 cursor-pointer text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(!open)}>
              {open ? "Show less" : "Show more"}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
