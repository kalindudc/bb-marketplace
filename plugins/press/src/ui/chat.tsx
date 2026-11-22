import { experimental_useRpcQuery, type ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { useId, useState } from "react";
import { rpcContract, type CompactionSummary } from "../contract";
import { boundaryEntry, chatText } from "./model";
import { PressSummary } from "./summary";

function BoundaryRow({ entry, threadId }: { entry: CompactionSummary; threadId: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className="press-chat">
    <div className="press-chat-line">
      <span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 2.5V7m-2.8-1.8L12 8l2.8-2.8M4 11h16M4 15.5h16m-10.8 3.3L12 16l2.8 2.8M12 16v4.5" />
        </svg>
        {chatText(entry)}
      </span>
      {entry.summaryPath !== null && <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        {open ? "Hide summary" : "Show summary"}
      </button>}
    </div>
    <div id={id} hidden={!open}>{open && <PressSummary threadId={threadId} at={entry.at} />}</div>
  </div>;
}

export function PressMessageMetadata({ message }: ExperimentalMessageMetadataProps) {
  const { data } = experimental_useRpcQuery({ contract: rpcContract, method: "status", input: { threadId: message.threadId } });
  const entry = boundaryEntry(data, message);
  return entry ? <BoundaryRow key={entry.id} entry={entry} threadId={message.threadId} /> : null;
}
