import { Markdown, ThreadChat, experimental_FileLink as FileLink, useBbNavigate, type ExperimentalLiveFileTarget } from "@get-bb/plugin-sdk/app";
import { FoldSummary } from "./glyphs";
import { Prose } from "./report-view";
import type { BoardQuestDetail } from "../../shared/contract";

type Tale = NonNullable<BoardQuestDetail["tale"]>;
type Link = { start: number; end: number; label: string; target: ExperimentalLiveFileTarget };
function localLinks(text: string, threadId: string, tale: Tale): Link[] {
  const links: Link[] = [];
  const pattern = /\[([^\]\n]+)\]\((<[^>\n]+>|[^\s)]+)\)|`([^`\n]+)`|(?:file:\/\/\/[^\s<>`"()]+|\$BB_THREAD_STORAGE\/[^\s<>`"()]+|(?<![\w/:])\/(?:[\w.@-]+\/)*[\w.@-]+)/g;
  let fence: string | null = null;
  const searchable = text.split("\n").map(line => {
    const mark = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && !mark[2]!.trim()) fence = null;
      return " ".repeat(line.length);
    }
    if (mark) { fence = mark[1]!; return " ".repeat(line.length); }
    return line;
  }).join("\n");
  for (const match of searchable.matchAll(pattern)) {
    const raw = (match[2]?.replace(/^<|>$/g, "") ?? match[3] ?? match[0]).replace(/[.,;]+$/, "");
    let path = raw;
    if (raw.startsWith("file:")) {
      try { const url = new URL(raw); if (url.hostname && url.hostname !== "localhost") continue; path = decodeURIComponent(url.pathname); }
      catch { continue; }
    }
    if (!match[2] && !/\.[\w-]+$/.test(path.split("/").at(-1) ?? "")) continue;
    let target: ExperimentalLiveFileTarget;
    if (path.startsWith("$BB_THREAD_STORAGE/")) target = { kind: "thread-storage", threadId, path: path.slice("$BB_THREAD_STORAGE/".length) };
    else if (path.startsWith("/") && tale.fileHostId) target = { kind: "host", hostId: tale.fileHostId, path };
    else if (path.startsWith("/") && tale.document && path.startsWith(tale.document.rootPath.replace(/\/$/, "") + "/")) target = { ...tale.document.target, path: path.slice(tale.document.rootPath.replace(/\/$/, "").length + 1) };
    else continue;
    links.push({ start: match.index!, end: match.index! + match[0].length, label: match[1] ?? path.split("/").at(-1) ?? path, target });
  }
  return links;
}

export function TaleAction({ text, threadId, tale }: { text: string; threadId: string; tale: Tale }) {
  const links = localLinks(text, threadId, tale);
  let at = 0;
  return <>{links.map((link, i) => { const before = text.slice(at, link.start); at = link.end; return <span key={i}><Prose text={before} /><FileLink target={link.target}>{link.label}</FileLink></span>; })}<Prose text={text.slice(at)} /></>;
}

type Block = { kind: "markdown" | "visual"; source: string };
export function taleDeliveryBlocks(text: string, questId: string): Block[] {
  const blocks: Block[] = [];
  let markdown = "";
  const flush = () => { if (markdown.trim()) blocks.push({ kind: "markdown", source: markdown }); markdown = ""; };
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const source = [line];
      for (i++; i < lines.length; i++) {
        const next = lines[i]!; source.push(next);
        const close = next.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1]![0] === fence[1]![0] && close[1]!.length >= fence[1]!.length) break;
      }
      if (["ui", "app"].includes(fence[2]!.trim().split(/\s/)[0]!)) { flush(); blocks.push({ kind: "visual", source: source.join("\n") }); }
      else markdown += source.join("\n") + "\n";
    } else if (line.trim() === `::tavern-tale{quest="${questId}"}`) continue;
    else if (/^\s*::[\w-]+\{.*\}\s*$/.test(line)) { flush(); blocks.push({ kind: "visual", source: line }); }
    else markdown += line + "\n";
  }
  flush();
  return blocks;
}

export function TaleDelivery({ tale, questId, threadId, keeperName }: { tale: Tale; questId: string; threadId: string; keeperName: string }) {
  const navigate = useBbNavigate();
  const delivery = tale.delivery;
  if (delivery?.companionThreadId && delivery.companionReady && !delivery.companionFailed) return <div className="tale-delivery-rendered"><ThreadChat threadId={delivery.companionThreadId} variant="timeline" layout="document" permissionPolicy="inherit" /></div>;
  const text = delivery?.text ?? "";
  const links = localLinks(text, threadId, tale).filter((link, i, all) => all.findIndex(other => JSON.stringify(other.target) === JSON.stringify(link.target)) === i);
  return <><div className="tale-delivery-text">{taleDeliveryBlocks(text, questId).map((block, i) => block.kind === "markdown"
    ? <div key={i} className="tale-delivery-markdown"><Markdown content={block.source} experimental_document={tale.document} /></div>
    : <div key={i} className="tale-visual"><p>A visual in {keeperName}'s message</p><button type="button" className="lnk-btn act" onClick={() => navigate.toThread(threadId)}>Open the Keeper's thread ›</button><details><FoldSummary>Show source</FoldSummary><pre><code>{block.source}</code></pre></details></div>)}</div>
    {links.length > 0 && <section className="tale-files"><h4>Files in this delivery</h4><ul aria-label="Files in this delivery">{links.map((link, i) => <li key={i}><FileLink target={link.target}>{link.label}</FileLink></li>)}</ul></section>}
  </>;
}
