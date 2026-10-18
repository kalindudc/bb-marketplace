import { createContext, useContext, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { PluginBrowserBbSdk, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { keyboardFocusOnly } from "./hint";
import { portalScopeProps } from "./portal-scope";
import { infoLoaders, prefetchInfo } from "./info-data";
import { InfoCardBody } from "./info-card-body";
import type { InfoCardMode } from "./settings";
import { STATE_LABEL, type RowState } from "./status";

const OPEN_DELAY_MS = 300;
const SKIP_DELAY_MS = 500;
const PREFETCH_DELAY_MS = 120;

interface InfoCardSettings { mode: InfoCardMode; sdk: PluginBrowserBbSdk | null; isSuppressed(): boolean }
const InfoCardContext = createContext<InfoCardSettings>({ mode: "off", sdk: null, isSuppressed: () => true });

export function InfoCardProvider({ mode, sdk, isSuppressed, children }: { mode: InfoCardMode; sdk: PluginBrowserBbSdk;
  isSuppressed(): boolean; children: ReactNode }): ReactElement {
  const value = useMemo(() => ({ mode, sdk, isSuppressed }), [mode, sdk, isSuppressed]);
  return <Tooltip.Provider delayDuration={OPEN_DELAY_MS} skipDelayDuration={SKIP_DELAY_MS} disableHoverableContent>
    <InfoCardContext.Provider value={value}>{children}</InfoCardContext.Provider>
  </Tooltip.Provider>;
}

export function useInfoCardMode(): InfoCardMode {
  return useContext(InfoCardContext).mode;
}

interface InfoCardProps { thread: PluginSidebarThread; state: RowState; projectName: string; stale: boolean; now: number; children: ReactElement }

export function InfoCard(props: InfoCardProps): ReactElement {
  const { mode, sdk, isSuppressed } = useContext(InfoCardContext);
  if (mode === "off" || sdk === null) return props.children;
  return <InfoCardRoot {...props} mode={mode} sdk={sdk} isSuppressed={isSuppressed} />;
}

function InfoCardRoot({ thread, state, projectName, stale, now, children, mode, sdk, isSuppressed }: InfoCardProps & {
  mode: Exclude<InfoCardMode, "off">; sdk: PluginBrowserBbSdk; isSuppressed(): boolean }) {
  const [open, setOpen] = useState(false);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = () => {
    if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  };
  useEffect(() => cancelPrefetch, []);
  const startPrefetch = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return;
    cancelPrefetch();
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      prefetchInfo(infoLoaders(sdk, thread, mode));
    }, PREFETCH_DELAY_MS);
  };
  const branch = thread.environment?.branchName;
  const label = `${thread.indicatorLabel ?? STATE_LABEL[state]}, ${projectName}${branch ? `, branch ${branch}` : ""}`;
  // Switchboard's drag listens on window without pointer capture, so other rows still see pointer moves mid-drag.
  return <Tooltip.Root open={open} onOpenChange={(next) => setOpen(next && !isSuppressed())}>
    <Tooltip.Trigger asChild onFocus={keyboardFocusOnly} onPointerDown={() => setOpen(false)}
      onPointerEnter={startPrefetch} onPointerLeave={cancelPrefetch}>{children}</Tooltip.Trigger>
    <Tooltip.Portal>
      <Tooltip.Content {...portalScopeProps()} side="right" align="start" sideOffset={8} collisionPadding={8}
        aria-label={label} className={`sb-info-card sb-info-${mode}`}>
        <InfoCardBody thread={thread} state={state} projectName={projectName} stale={stale} now={now} mode={mode} sdk={sdk} />
      </Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>;
}
