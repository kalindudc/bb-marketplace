import { experimental_useAppPanel, experimental_useRpcQuery, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { createPortal } from "react-dom";
import { rpcContract } from "../contract";
import { useFooterMount } from "./footer";
import { chipText, PRESS_TAB } from "./model";

export function PressFooterChip({ threadId }: { threadId: string }) {
  const panel = experimental_useAppPanel();
  const navigate = useBbNavigate();
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "status", input: { threadId } });
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const mount = useFooterMount(data?.percent != null ? anchor : null);
  return <span ref={setAnchor} hidden>
    {mount && data?.percent != null && createPortal(
      <button type="button" className="press-chip press-footer-chip" aria-label={`Press: ${chipText(data)}`} title="Open Press"
        onClick={() => {
          // Burn's path: the thread panel action opens in this pane's side panel. The pinned SDK types
          // do not name it yet, so it is reached through a cast; openTab stays as the fallback.
          const open = (navigate as unknown as { openThreadPanel?(options: { actionId: string }): boolean }).openThreadPanel;
          if (open?.call(navigate, { actionId: PRESS_TAB.id }) !== true) panel.openTab({ tab: PRESS_TAB });
        }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle className="press-ring-track" cx="8" cy="8" r="6" strokeWidth="1.7" />
          <circle className="press-ring-arc" cx="8" cy="8" r="6" strokeWidth="1.7" pathLength="100"
            strokeDasharray="100" strokeDashoffset={100 - Math.max(0, Math.min(100, data.percent))}
            transform="rotate(-90 8 8)" />
        </svg>
        {chipText(data)}
      </button>, mount,
    )}
  </span>;
}
