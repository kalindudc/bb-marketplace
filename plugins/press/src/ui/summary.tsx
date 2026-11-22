import { Markdown, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "../contract";

export function PressSummary({ threadId, at }: { threadId: string; at: string }) {
  const { data, error } = experimental_useRpcQuery({ contract: rpcContract, method: "summary", input: { threadId, at } });
  return <div className="press-summary" tabIndex={0} role="region" aria-label="Full Press summary">
    {error ? <p role="alert">Could not load the summary.</p> : data === undefined ? <p role="status">Loading summary…</p>
      : data.markdown === null ? <p>No summary is available.</p> : <Markdown content={data.markdown} />}
  </div>;
}
