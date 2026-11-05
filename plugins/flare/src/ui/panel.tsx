import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ThreadChat, experimental_copyToClipboard, experimental_useRpcQuery, useSettings, type ExperimentalThreadActionTabProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rpcContract, type FlareDto } from "../contract";
import { FlareCard } from "./flare-card";
import { buildMarks, publishMarks, TurnHeader } from "./dividers";
import { feedMarkdown, groupFlares, sectionTitle, type Section } from "./group";
import { FLARE_ICON } from "./tab";
import { useNow } from "./use-now";

function TurnSection({ section, now }: { section: Section; now: number }) {
  return (
    <section className="space-y-2" aria-label={sectionTitle(section, now)}>
      <TurnHeader section={section} now={now} />
      {section.flares.map((flare) => (
        <FlareCard key={flare.id} flare={flare} now={now} />
      ))}
    </section>
  );
}

/** Flares the companion does not have: sent before it started, or while it could not be reached. */
function MissedFlares({ flares, now }: { flares: readonly FlareDto[]; now: number }) {
  return (
    <section className="space-y-2 px-3 pt-3" aria-label="Flares shown as cards">
      <p className="text-xs text-muted-foreground">
        {flares.length === 1 ? "1 flare is not drawn here yet; it shows as a card." : `${flares.length} flares are not drawn here yet; they show as cards.`}
      </p>
      {flares.map((flare) => (
        <FlareCard key={flare.id} flare={flare} now={now} />
      ))}
    </section>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <Icon name={FLARE_ICON} fallback="Zap" className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">No flares yet</p>
      <p className="max-w-72 text-xs text-muted-foreground">
        An agent sends a flare when it finds something worth telling you before its turn ends. Ask for it in your prompt, for example
        “send a flare when you find the cause”.
      </p>
    </div>
  );
}

type View = "rendered" | "cards";

/** A flare this new that the companion lacks is still being drawn, not missed. */
const ON_ITS_WAY_MS = 30_000;

/** Two buttons that keep their place whichever is chosen, so switching views never moves the toolbar. */
function ViewSwitch({ view, canRender, onChange }: { view: View; canRender: boolean; onChange: (view: View) => void }) {
  return (
    <div role="group" aria-label="How the Flares tab shows flares" className="flex shrink-0 items-center rounded-md border border-border p-0.5">
      <span title={canRender ? "Each flare as bb shows a reply" : "Shown once the next flare reaches this thread's renderer"}>
        <Button variant="ghost" size="sm" className="h-7 px-2" aria-pressed={view === "rendered"} disabled={!canRender} onClick={() => onChange("rendered")}>
          <Icon name="Eye" aria-hidden />
          Rendered
        </Button>
      </span>
      <Button variant="ghost" size="sm" className="h-7 px-2" aria-pressed={view === "cards"} onClick={() => onChange("cards")}>
        <Icon name="LayoutList" aria-hidden />
        Cards
      </Button>
    </div>
  );
}

/**
 * Keeps a scroll area on its newest entry, as a conversation is, while its content grows (a view that draws after it
 * loads, a new flare), unless the reader scrolled up to read. Both views use it, so they open in the same place.
 */
function useStickToBottom(key: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    pinned.current = true;
    const stick = () => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    };
    stick();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(stick);
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [key]);
  // Only the reader unpins: a scroll event alone may be this hook's own, racing content that grew in between.
  const onScroll = () => {
    const element = ref.current;
    if (element !== null && element.scrollHeight - element.scrollTop - element.clientHeight < 48) pinned.current = true;
  };
  const unpin = () => {
    pinned.current = false;
  };
  const onWheel = (event: { deltaY: number }) => {
    if (event.deltaY < 0) unpin();
  };
  const onKeyDown = (event: { key: string }) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) unpin();
  };
  return { ref, onScroll, onWheel, onKeyDown, onTouchMove: unpin };
}

const scrollHandlers = ({ onScroll, onWheel, onKeyDown, onTouchMove }: ReturnType<typeof useStickToBottom>) => ({ onScroll, onWheel, onKeyDown, onTouchMove });

function IconToggle({ icon, label, pressed, disabled, onClick }: { icon: string; label: string; pressed?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <span title={label}>
      <Button variant="ghost" size="sm" className="h-8 w-8 px-0" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
        <Icon name={icon} aria-hidden />
      </Button>
    </span>
  );
}

/** Every flare of a thread and the threads it started: drawn by bb in the companion, or as Flare's own cards. */
export function FlaresPanel({ threadId }: { threadId: string }) {
  const now = useNow();
  const [children, setChildren] = useState(true);
  const settings = useSettings();
  const preferred: View = settings.values?.tab === "cards" ? "cards" : "rendered";
  const [chosen, setChosen] = useState<View | null>(null);
  const wanted = chosen ?? preferred;
  // The companion holds every child flare, so the rendered view counts and copies them all, whatever the cards filter.
  const { data, error, isLoading } = experimental_useRpcQuery({
    contract: rpcContract,
    method: "feed",
    input: { threadId, children: wanted === "rendered" ? true : children },
  });
  const companion = data?.companionThreadId ?? null;
  const view: View = wanted === "rendered" && companion !== null ? "rendered" : "cards";
  const undrawn = view === "rendered" ? (data?.flares ?? []).filter((flare) => !flare.drawn) : [];
  const onTheirWay = undrawn.filter((flare) => now - flare.createdAt < ON_ITS_WAY_MS).length;
  const missed = undrawn.filter((flare) => now - flare.createdAt >= ON_ITS_WAY_MS).reverse();
  const sections = useMemo(() => (data === undefined ? [] : groupFlares(data)), [data]);
  const total = data?.flares.length ?? 0;
  // Which companion turn shows which flare, so bb can draw a divider with its time over each message.
  const { data: turns } = experimental_useRpcQuery({ contract: rpcContract, method: "marks", input: { threadId }, enabled: view === "rendered" });
  const marks = useMemo(() => (turns === undefined ? null : buildMarks(sections, turns.marks)), [sections, turns]);
  useEffect(() => {
    if (view !== "rendered" || companion === null || marks === null) return;
    publishMarks(companion, marks);
    return () => publishMarks(companion, null);
  }, [view, companion, marks]);
  const scroll = useStickToBottom(`${view}:${companion ?? ""}:${total}`);

  const copyAll = async () => {
    const copied = await experimental_copyToClipboard({ text: feedMarkdown(sections, Date.now()) });
    if (copied) toast.success(total === 1 ? "Copied 1 flare" : `Copied ${total} flares`);
    else toast.error("Could not copy the flares");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {isLoading ? "Loading flares…" : total === 1 ? "1 flare" : `${total}${data?.truncated ? "+" : ""} flares`}
        </p>
        <ViewSwitch view={view} canRender={companion !== null} onChange={setChosen} />
        <IconToggle
          icon="UserRound"
          label={view === "rendered" ? "Child threads' flares: always shown in the rendered view" : children ? "Hide child threads' flares" : "Show child threads' flares"}
          pressed={view === "rendered" || children}
          disabled={view === "rendered"}
          onClick={() => setChildren(!children)}
        />
        <IconToggle icon="Copy" label="Copy all as Markdown" disabled={total === 0} onClick={() => void copyAll()} />
      </div>
      {view === "rendered" && companion !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {onTheirWay > 0 && (
            <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
              {onTheirWay === 1 ? "1 flare is on its way." : `${onTheirWay} flares are on their way.`}
            </p>
          )}
          {/* "document" lets the chat grow, so this area scrolls and opens on the newest flare, as the cards do. */}
          <div ref={scroll.ref} {...scrollHandlers(scroll)} className="min-h-0 flex-1 overflow-y-auto" data-flare-rendered>
            <ThreadChat
              threadId={companion}
              variant="timeline"
              layout="document"
              permissionPolicy="inherit"
              leadingContent={missed.length === 0 ? undefined : <MissedFlares flares={missed} now={now} />}
            />
          </div>
        </div>
      ) : (
        <div ref={scroll.ref} {...scrollHandlers(scroll)} className="min-h-0 flex-1 overflow-y-auto p-3" data-flare-cards>
          {error !== null && data === undefined ? (
            <p className="text-sm text-destructive">Could not load the flares: {error.message}</p>
          ) : data !== undefined && total === 0 ? (
            <Empty />
          ) : (
            // Oldest first, newest at the bottom, as the rendered view and a conversation read.
            <div className="space-y-5">
              {data?.truncated && <p className="text-center text-xs text-muted-foreground">Older flares are not shown; <code>bb flare list --limit 5000</code> prints more.</p>}
              {sections.map((section) => (
                <TurnSection key={section.key} section={section} now={now} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function FlaresTab({ threadId }: ExperimentalThreadActionTabProps) {
  return <FlaresPanel threadId={threadId} />;
}
