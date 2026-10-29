import { Fragment, useState, type ReactNode } from "react";
import { GIT_NETWORK_TIMEOUT_MS } from "../git-network";
import { HOOK_EVENT_NAMES, HOOK_EVENTS } from "../hook-events";
import type { EnvironmentSpec, ForgeSpec, MachineSpec, RepoSpec, Spec } from "../spec";
import { textSteps, type TextStep } from "../spec-diff";
import { isUnder } from "../spec-paths";
import { BUTTON, CHIP, HEADING, RepoChip, listText, plural } from "./common";
import { CHANGED_TAG, Commentable, DiffList, Pin, REMOVED_TAG, WasBadge, changeAt, changedAt, foundAt, kept, notedAt, pinsAt, useReview, type CommentTarget, type ListMark, type Review, type SpecValue } from "./spec-review-kit";

const CODE = "rounded bg-surface-recessed px-1 font-mono text-xs [overflow-wrap:anywhere]";
/** A card's labels and values: side by side once the card has room for both, one under the other in a narrow card. */
const ROWS = "grid grid-cols-1 gap-x-3 gap-y-0.5 @min-[17rem]:grid-cols-[7rem_minmax(0,1fr)] @min-[17rem]:gap-y-1.5";
const minutes = (n: number) => (n % 60 === 0 ? `${n / 60} h` : plural(n, "minute"));
const DEFAULT_GIT_SECONDS = GIT_NETWORK_TIMEOUT_MS / 1000;
type DeploySpec = NonNullable<RepoSpec["deploy"]>;

/** A choice of the spec as a segmented control: the option in force is raised, and clicking another one suggests it. */
function Choice({ path, label, value, options, names }: { path: string; label: string; value: SpecValue; options: readonly SpecValue[]; names: Readonly<Record<string, string>> }) {
  const review = useReview();
  return (
    <Commentable as="span" className="inline-flex flex-wrap items-center" target={{ paths: [path], label, kind: "enum", value, options, names }}>
      <span role="group" aria-label={label} className="inline-flex flex-wrap gap-0.5 rounded-md bg-surface-recessed p-0.5">
        {options.map((option) =>
          option === value ? (
            <span key={String(option)} data-option={String(option)} aria-current="true" className="rounded bg-card px-2 py-0.5 text-xs font-semibold text-foreground shadow-sm">
              {names[String(option)] ?? String(option)}
            </span>
          ) : (
            <span
              key={String(option)}
              data-option={String(option)}
              data-preset={review.onComment === undefined ? undefined : String(option)}
              title={review.onComment === undefined ? undefined : `Suggest ${names[String(option)] ?? String(option)}`}
              className={`rounded px-2 py-0.5 text-xs text-muted-foreground ${review.onComment === undefined ? "" : "hover:bg-state-hover hover:text-foreground"}`}
            >
              {names[String(option)] ?? String(option)}
            </span>
          ),
        )}
      </span>
    </Commentable>
  );
}

function Slots({ n, max }: { n: number; max: number }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-[3px]" aria-label={`${n} of up to ${max}`}>
      {Array.from({ length: max }, (_, index) => (
        <span key={index} aria-hidden className={`size-3 rounded-[3px] border ${index < n ? "border-primary bg-primary" : "border-border-seam bg-card"}`} />
      ))}
      <b className="ml-1.5 text-sm tabular-nums">{n}</b>
    </span>
  );
}

/** "anthropic/claude-sonnet-5-5" may break after its slash before it breaks inside a word. */
function modelParts(model: string): ReactNode {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  return (
    <>
      {model.slice(0, slash + 1)}
      <wbr />
      {model.slice(slash + 1)}
    </>
  );
}

function Model({ agent }: { agent: { provider?: string; model?: string } }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="rounded bg-surface-recessed px-1.5 text-[11px] leading-[18px] text-muted-foreground">{agent.provider ?? "default provider"}</span>
      {agent.model === undefined ? (
        <span className="font-mono text-xs">default model</span>
      ) : (
        <span data-model={agent.model} className="font-mono text-xs [overflow-wrap:anywhere]">
          {modelParts(agent.model)}
        </span>
      )}
    </span>
  );
}

/** A label and its value; faded while only what changed is shown and this row did not. */
function Row({ label, paths, children }: { label: string; paths: readonly string[]; children: ReactNode }) {
  const review = useReview();
  const faded = review.only && !kept(review, paths);
  return (
    <>
      <dt className={`pt-1 text-xs text-muted-foreground ${faded ? "opacity-45" : ""}`}>{label}</dt>
      <dd className={`min-w-0 text-sm ${faded ? "opacity-45" : ""}`}>{children}</dd>
    </>
  );
}

const value = (path: string, label: string, kind: CommentTarget["kind"], current?: SpecValue, extra: Partial<CommentTarget> = {}): CommentTarget => ({ paths: [path], label, kind, ...(current === undefined ? {} : { value: current }), ...extra });

interface SettingsCard {
  id: string;
  title: string;
  note?: string;
  /** The spec paths the card shows. */
  paths: string[];
  wide?: boolean;
  full?: boolean;
  body: ReactNode;
}

function Card({ card }: { card: SettingsCard }) {
  const review = useReview();
  const changed = card.paths.some((path) => changedAt(review, path));
  const pins = pinsAt(review, card.paths[0]!);
  return (
    <section
      data-settings-card={card.id}
      data-anchor={card.paths.join(" ")}
      data-changed={changed || undefined}
      aria-label={card.title}
      className={`@container min-w-0 rounded-lg border bg-card p-3 ${changed ? "border-primary ring-1 ring-primary ring-inset" : "border-border-seam"} ${card.full ? "@xl:col-span-2 @5xl:col-span-3" : card.wide ? "@xl:col-span-2" : ""}`}
    >
      <header className="mb-2.5 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{card.title}</h3>
        {card.note !== undefined && (
          <span className="min-w-0 truncate text-xs text-muted-foreground" title={card.note}>
            {card.note}
          </span>
        )}
        {changed && <span className={CHANGED_TAG}>changed</span>}
        {pins.map((n) => (
          <Pin key={n} n={n} />
        ))}
        {review.onComment !== undefined && (
          <button type="button" className={`${CHIP} ml-auto cursor-pointer px-2 text-muted-foreground hover:text-foreground`} onClick={(event) => review.onComment!({ paths: card.paths, label: card.title, kind: "text" }, event.currentTarget)}>
            Comment
          </button>
        )}
      </header>
      {card.body}
    </section>
  );
}

/** The commands of a list as numbered steps, with what changed marked. */
function Steps({ path, label, commands, missing }: { path: string; label: string; commands: readonly string[]; missing?: readonly string[] }) {
  const step = (command: string, mark: ListMark, index: number) =>
    mark === "removed" ? (
      <span data-removed className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-destructive-text/40 bg-destructive-text/5 px-2 py-0.5 font-mono text-[11.5px] text-destructive-text line-through">
        {command}
      </span>
    ) : (
      <Commentable as="span" target={value(`${path}[${index}]`, `${label} ${index + 1}`, "command")} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11.5px] ${mark === "added" ? "border-success bg-success/15" : "border-border-seam bg-surface-recessed/50"}`}>
        <span className="font-sans text-[10px] text-subtle-foreground">{index + 1}</span>
        <span className="[overflow-wrap:anywhere]">{command}</span>
        {mark === "added" && <span className="font-sans text-[10px] font-semibold text-success">new</span>}
      </Commentable>
    );
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DiffList path={path} items={commands} render={step} compact={false} />
      {missing?.map((command) => (
        <span key={command} data-skipped title="Runs on every ticket, but not after a merge" className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border-seam px-2 py-0.5 font-mono text-[11.5px] text-subtle-foreground">
          {command}
          <span className="font-sans text-[10px]">tickets only</span>
        </span>
      ))}
    </div>
  );
}

function Piece({ step }: { step: TextStep }) {
  return step.op === "same" ? <span>{step.text}</span> : step.op === "added" ? <ins className="rounded-sm bg-success/15 text-success no-underline">{step.text}</ins> : <del className="rounded-sm bg-destructive-text/10 text-destructive-text">{step.text}</del>;
}

/** A version's old and new text, word by word. */
function Diff({ before, after }: { before: string; after: string }) {
  return (
    <span data-diff className="whitespace-pre-wrap [overflow-wrap:anywhere]">
      {textSteps(before, after).map((step, index) => (
        <Piece key={index} step={step} />
      ))}
    </span>
  );
}

/** Words the spec sets at `path`, such as a stage's goal: a version's change shows as a word diff, a removal struck through. */
export function Prose({ path, label, text, fallback = "not set", className = "" }: { path: string; label: string; text: string | undefined; fallback?: string; className?: string }) {
  const review = useReview();
  const change = changeAt(review, path);
  const before = (change?.kind === "value" || change?.kind === "text") && typeof change.before === "string" ? change.before : undefined;
  return (
    <Commentable as="span" target={value(path, label, "text")} showWas={before === undefined} className={`min-w-0 [overflow-wrap:anywhere] ${className}`}>
      {before === undefined ? (
        (text ?? <span className="text-muted-foreground">{fallback}</span>)
      ) : text === undefined ? (
        <>
          <del className="text-destructive-text">{before}</del> <span className="text-muted-foreground">{fallback}</span>
        </>
      ) : (
        <Diff before={before} after={text} />
      )}
    </Commentable>
  );
}

/** Text as lines of steps, so a command folds by line whether it shows as it is, as a diff or as a removal. */
function linesOf(steps: readonly TextStep[]): TextStep[][] {
  const lines: TextStep[][] = [[]];
  for (const step of steps) {
    step.text.split("\n").forEach((text, index) => {
      if (index > 0) lines.push([]);
      if (text !== "") lines.at(-1)!.push({ op: step.op, text });
    });
  }
  return lines;
}

/**
 * A command as code, folded to its first line, and in a diff the lines that changed, with the whole text one click away:
 * a forge's feedback command can run 20 lines. `target` is null for a list entry a version removed, which the list's
 * label takes comments for.
 */
function Folded({ target, steps, diff = false, className = "", tag }: { target: CommentTarget | null; steps: readonly TextStep[]; diff?: boolean; className?: string; tag?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const lines = linesOf(steps);
  const stays = lines.map((line, index) => index === 0 || (diff && line.some((step) => step.op !== "same")));
  const hidden = stays.filter((one) => !one).length;
  const rows: ReactNode[] = [];
  lines.forEach((line, index) => {
    if (open || stays[index]) rows.push(line.map((step, at) => <Piece key={at} step={step} />));
    else if (stays[index - 1]) rows.push(<span className="text-subtle-foreground">⋯</span>);
  });
  const code = (
    <>
      <code className="block font-mono text-[11.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 && "\n"}
            {row}
          </Fragment>
        ))}
      </code>
      {tag}
    </>
  );
  const box = `min-w-0 flex-1 px-1.5 py-1 ${className}`;
  return (
    <div className="flex min-w-0 items-start gap-1">
      {target === null ? (
        <div data-removed className={`rounded-md ${box}`}>
          {code}
        </div>
      ) : (
        <Commentable target={target} showWas={false} className={box}>
          {code}
        </Commentable>
      )}
      {hidden > 0 && (
        <button type="button" aria-expanded={open} className={`${CHIP} shrink-0 cursor-pointer px-2 text-muted-foreground hover:text-foreground`} onClick={() => setOpen(!open)}>
          {open ? "Fold" : `+${plural(hidden, "line")}`}
        </button>
      )}
    </div>
  );
}

const same = (text: string): TextStep[] => [{ op: "same", text }];
const NEW = <span className="text-[10px] font-semibold text-success">new</span>;

/** A command the spec sets at `path`: new, rewritten (its old and new text) or removed in this version, or as it is. */
export function Command({ path, label, command }: { path: string; label: string; command: string | undefined }) {
  const review = useReview();
  const change = changeAt(review, path);
  const before = (change?.kind === "value" || change?.kind === "text") && typeof change.before === "string" ? change.before : undefined;
  const target = value(path, label, "command");
  if (command === undefined) {
    return before === undefined ? null : <Folded target={target} steps={[{ op: "removed", text: before }]} tag={<span className={`${REMOVED_TAG} ml-1`}>removed</span>} />;
  }
  if (before !== undefined) return <Folded target={target} steps={textSteps(before, command)} diff className="bg-surface-recessed ring-1 ring-primary" />;
  return <Folded target={target} steps={same(command)} className={change === undefined ? "bg-surface-recessed" : "bg-success/15 ring-1 ring-success"} tag={change === undefined ? undefined : NEW} />;
}

/** One part of a forge, an environment or a deploy: a small label over its value, faded while only what changed is shown and it did not. */
function Part({ label, paths, target, children }: { label: string; paths: readonly string[]; target?: CommentTarget; children: ReactNode }) {
  const review = useReview();
  const faded = review.only && !kept(review, paths);
  return (
    <div data-faded={faded || undefined} className={`min-w-0 space-y-0.5 ${faded ? "opacity-45" : ""}`}>
      {target === undefined ? (
        <p className="text-[11px] text-muted-foreground">{label}</p>
      ) : (
        // A list's own target: a version that removes its entries changes the list, and What changed goes here.
        <Commentable target={target} showWas={false} className="inline-block text-[11px] text-muted-foreground">
          {label}
        </Commentable>
      )}
      {children}
    </div>
  );
}

const FORGE_KINDS: Record<ForgeSpec["kind"], string> = { gh: "GitHub through gh", command: "the spec's own commands", none: "none: Loom only pushes the branch" };
const FORGE_COMMANDS = [
  ["open", "Opens pull requests"],
  ["state", "Reads open, merged or closed"],
  ["feedback", "Reads checks and reviews"],
  ["edit", "Edits a pull request's text"],
  ["reply", "Replies to review comments"],
  ["retarget", "Moves a pull request to another base"],
] as const;
const FORGE_HOOKS = [
  ["after_open", "After opening"],
  ["after_push", "After each push"],
] as const;
const hasForgeParts = (forge: ForgeSpec | undefined) => forge !== undefined && (FORGE_COMMANDS.some(([key]) => forge[key] !== undefined) || FORGE_HOOKS.some(([key]) => (forge[key]?.length ?? 0) > 0) || (forge.ignore_checks?.length ?? 0) > 0);

/**
 * A forge as rows of a settings list: its kind, then each command it sets, in words and folded to its first line, and the
 * checks it ignores. `inherited` says what applies when the spec sets no forge at `path`.
 */
function ForgeRows({ path, label, forge, inherited }: { path: string; label: string; forge: ForgeSpec | undefined; inherited: string }) {
  const review = useReview();
  const shown = (key: string, set: boolean) => set || changedAt(review, `${path}.${key}`);
  const commands = FORGE_COMMANDS.filter(([key]) => shown(key, forge?.[key] !== undefined));
  const hooks = FORGE_HOOKS.filter(([key]) => shown(key, (forge?.[key]?.length ?? 0) > 0));
  const ignored = forge?.ignore_checks ?? [];
  const ignoring = shown("ignore_checks", ignored.length > 0);
  const kind = forge === undefined ? (changeAt(review, `${path}.kind`) === undefined ? path : `${path}.kind`) : `${path}.kind`;
  return (
    <>
      <Row label="Forge" paths={[path]}>
        {forge === undefined ? (
          <Commentable as="span" target={value(kind, label, "text")} className="text-muted-foreground">
            {inherited}
          </Commentable>
        ) : (
          <Commentable as="span" target={value(kind, label, "enum", forge.kind, { options: ["gh", "command", "none"], names: FORGE_KINDS })}>
            {FORGE_KINDS[forge.kind]}
          </Commentable>
        )}
      </Row>
      {(commands.length > 0 || hooks.length > 0 || ignoring) && (
        <dd data-forge={path} className="col-span-full min-w-0 space-y-1.5 border-l-2 border-border-seam pl-2">
          {commands.map(([key, name]) => (
            <Part key={key} label={name} paths={[`${path}.${key}`]}>
              <Command path={`${path}.${key}`} label={`${label} › ${key}`} command={forge?.[key]} />
            </Part>
          ))}
          {hooks.map(([key, name]) => (
            <Part key={key} label={name} paths={[`${path}.${key}`]} target={value(`${path}.${key}`, `${label} › ${key.replace(/_/g, " ")}`, "command")}>
              <div className="space-y-1">
                <DiffList
                  path={`${path}.${key}`}
                  items={forge?.[key] ?? []}
                  compact={false}
                  render={(command, mark, index) =>
                    mark === "removed" ? (
                      <Folded target={null} steps={[{ op: "removed", text: command }]} tag={<span className={`${REMOVED_TAG} ml-1`}>removed</span>} />
                    ) : (
                      <Folded target={value(`${path}.${key}[${index}]`, `${label} › ${key.replace(/_/g, " ")} ${index + 1}`, "command")} steps={same(command)} className={mark === "added" ? "bg-success/15 ring-1 ring-success" : "bg-surface-recessed"} tag={mark === "added" ? NEW : undefined} />
                    )
                  }
                />
              </div>
            </Part>
          ))}
          {ignoring && (
            <Part label="Ignores these checks" paths={[`${path}.ignore_checks`]} target={value(`${path}.ignore_checks`, `${label} › ignore checks`, "text")}>
              <div className="flex min-w-0 flex-wrap gap-1">
                <DiffList
                  path={`${path}.ignore_checks`}
                  items={ignored}
                  compact={false}
                  render={(glob, mark, index) =>
                    mark === "removed" ? (
                      <span data-removed className="rounded-full bg-destructive-text/10 px-2 font-mono text-[11px] leading-5 text-destructive-text line-through">
                        {glob}
                      </span>
                    ) : (
                      <Commentable as="span" target={value(`${path}.ignore_checks[${index}]`, `${label} › ignore checks ${index + 1}`, "text")} className={`rounded-full border px-2 font-mono text-[11px] leading-5 [overflow-wrap:anywhere] ${mark === "added" ? "border-success bg-success/15" : "border-border-seam"}`}>
                        {glob}
                      </Commentable>
                    )
                  }
                />
              </div>
            </Part>
          )}
        </dd>
      )}
    </>
  );
}

const inputText = (input: unknown) => JSON.stringify(input) ?? String(input);

/** A provider's inputs, each `key = value` a part of its own, with the keys this version removed struck through. */
export function Inputs({ path, label, inputs }: { path: string; label: string; inputs: Readonly<Record<string, unknown>> | undefined }) {
  const review = useReview();
  const keys = Object.keys(inputs ?? {});
  const under = (key: string) => review.changes.filter((change) => change.path === `${path}.${key}` || isUnder(change.path, `${path}.${key}`)).map((change) => change.path);
  const gone = [...new Set(review.changes.filter((change) => isUnder(change.path, path)).map((change) => change.path.slice(path.length + 1).split(/[.[]/)[0]!))].filter((key) => !keys.includes(key));
  if (keys.length === 0 && gone.length === 0) return null;
  // A value's own changes sit under its key, so the key's part names them too and What changed goes to it.
  const target = (key: string) => ({ paths: [`${path}.${key}`, ...under(key).filter((one) => one !== `${path}.${key}`)], label: `${label} › ${key}`, kind: "text" as const });
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {keys.map((key) => {
        const change = changeAt(review, `${path}.${key}`);
        return (
          <Commentable key={key} as="span" target={target(key)} showWas={false} className={`rounded bg-surface-recessed px-1.5 font-mono text-xs [overflow-wrap:anywhere] ${under(key).length > 0 ? "ring-1 ring-primary" : ""}`}>
            {key} = {change?.kind === "value" && change.before !== undefined ? <Diff before={inputText(change.before)} after={inputText(inputs![key])} /> : inputText(inputs![key])}
          </Commentable>
        );
      })}
      {gone.map((key) => {
        const change = changeAt(review, `${path}.${key}`);
        return (
          <Commentable key={key} as="span" target={target(key)} showWas={false} className="rounded bg-destructive-text/10 px-1.5 font-mono text-xs text-destructive-text [overflow-wrap:anywhere]">
            <del>
              {key}
              {change?.kind === "value" || change?.kind === "text" ? ` = ${inputText(change.before)}` : ""}
            </del>{" "}
            <span className={REMOVED_TAG}>removed</span>
          </Commentable>
        );
      })}
    </span>
  );
}

interface RemovedTable {
  index: number;
  at: string;
  /** The paths of the version it is compared with that this version removed. */
  paths: string[];
  /** Each field's old value. */
  old: Readonly<Record<string, unknown>>;
}

/** The tables of a listed table, such as `rollout.stage`, that this version removed: the ones past the `kept` it still has. */
function removedTables(review: Review, list: string, kept: number): RemovedTable[] {
  const tables = new Map<number, RemovedTable & { old: Record<string, unknown> }>();
  for (const change of review.changes) {
    const match = /^(.*?)\[(\d+)\]\.(\w+)/.exec(change.path);
    if (match === null || match[1] !== list || Number(match[2]) < kept) continue;
    const index = Number(match[2]);
    const table = tables.get(index) ?? { index, at: `${list}[${index}]`, paths: [], old: {} };
    table.paths.push(change.path);
    if (change.path === `${table.at}.${match[3]}` && (change.kind === "value" || change.kind === "text")) table.old[match[3]!] = change.before;
    tables.set(index, table);
  }
  return [...tables.values()].sort((a, b) => a.index - b.index);
}

/** A table this version removed, struck through, whose target names every path it lost. */
function RemovedRow({ table, label, children }: { table: RemovedTable; label: string; children: ReactNode }) {
  return (
    <li data-removed-row={table.at} className="min-w-0">
      <Commentable target={{ paths: [table.at, ...table.paths], label, kind: "text" }} showWas={false} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 border border-dashed border-destructive-text/40 bg-destructive-text/5 px-2 py-1.5 text-sm text-destructive-text [overflow-wrap:anywhere]">
        <del className="min-w-0">{children}</del>
        <span className={REMOVED_TAG}>removed</span>
      </Commentable>
    </li>
  );
}

const oldText = (table: RemovedTable, key: string) => (typeof table.old[key] === "string" ? (table.old[key] as string) : "");

/** A provider id and its inputs. */
function Provider({ path, label, provider, inputs, inherited }: { path: string; label: string; provider: string | undefined; inputs: Readonly<Record<string, unknown>> | undefined; inherited: string }) {
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      <Commentable as="span" target={value(`${path}.provider`, `${label} › provider`, "text", provider)} className={provider === undefined ? "text-muted-foreground" : "font-mono text-xs [overflow-wrap:anywhere]"}>
        {provider ?? inherited}
      </Commentable>
      <Inputs path={`${path}.inputs`} label={`${label} › inputs`} inputs={inputs} />
    </span>
  );
}

function Machine({ path, label, machine, inherited }: { path: string; label: string; machine: MachineSpec | undefined; inherited: string }) {
  const review = useReview();
  if (machine === undefined && !changedAt(review, path)) {
    return (
      <Commentable as="span" target={value(path, label, "text")} className="text-muted-foreground">
        {inherited}
      </Commentable>
    );
  }
  return <Provider path={path} label={label} provider={machine?.provider} inputs={machine?.inputs} inherited="none" />;
}

/** Where the workers start: the provider and its inputs, and the new machine per thread when there is one. */
function WorkerEnvironmentRows({ path, label, environment, inherited }: { path: string; label: string; environment: EnvironmentSpec | undefined; inherited: string }) {
  const review = useReview();
  return (
    <>
      <Row label="Environment" paths={[`${path}.provider`, `${path}.inputs`]}>
        <Provider path={path} label={label} provider={environment?.provider} inputs={environment?.inputs} inherited={inherited} />
      </Row>
      {(environment?.machine !== undefined || changedAt(review, `${path}.machine`)) && (
        <Row label="Machine" paths={[`${path}.machine`]}>
          <Machine path={`${path}.machine`} label={`${label} › machine`} machine={environment?.machine} inherited="none" />
        </Row>
      )}
    </>
  );
}

/** Where reviewers, the spec reviewer and the summary agent start: the workers' environment, another provider, or the same one with a patch over its inputs. */
function ReviewerEnvironmentRows({ path, label, environment }: { path: string; label: string; environment: EnvironmentSpec | undefined }) {
  const review = useReview();
  const at = `${path}.reviewer`;
  const own = environment?.reviewer;
  if (own === undefined && !changedAt(review, at)) {
    return (
      <Row label="Reviewers start" paths={[at]}>
        <Commentable as="span" target={value(at, `${label} › reviewer`, "text")} className="text-muted-foreground">
          in the workers' environment
        </Commentable>
      </Row>
    );
  }
  const other = own?.provider !== undefined;
  return (
    <>
      <Row label="Reviewers start" paths={[`${at}.provider`, `${at}.inputs`]}>
        <Provider path={at} label={`${label} › reviewer`} provider={own?.provider} inputs={own?.inputs} inherited={own?.inputs === undefined ? "the workers' provider" : "the workers' provider, with these inputs over theirs"} />
      </Row>
      {(own?.machine !== undefined || environment?.machine !== undefined || changedAt(review, `${at}.machine`)) && (
        <Row label="Reviewer machine" paths={[`${at}.machine`]}>
          <Machine path={`${at}.machine`} label={`${label} › reviewer › machine`} machine={own?.machine} inherited={other || environment?.machine === undefined ? "none" : "the workers' machine"} />
        </Row>
      )}
    </>
  );
}

const ciText = (ci: boolean) => (ci ? "The pull request's CI runs every other test" : "Loom ignores the pull request's CI: its own checks are the whole bar");

function RefreshBehind({ path, label, n, base }: { path: string; label: string; n: number | undefined; base: string }) {
  return n === undefined ? (
    <Commentable as="span" target={value(path, label, "text")} className="text-muted-foreground">
      off
    </Commentable>
  ) : (
    <Commentable as="span" target={value(path, label, "number", n, { min: 1, max: 1_000_000 })}>
      Loom merges <code className={CODE}>{base}</code> into an open pull request that lacks <b className="tabular-nums">{plural(n, "commit")}</b> of it
    </Commentable>
  );
}

function GitTimeout({ path, label, seconds }: { path: string; label: string; seconds: number | undefined }) {
  return (
    <Commentable as="span" target={value(path, label, "number", seconds ?? DEFAULT_GIT_SECONDS, { min: 30, max: 600, step: 30, unit: "s" })}>
      <b className="tabular-nums">{seconds ?? DEFAULT_GIT_SECONDS} s</b>
      {seconds === undefined && ", the default"} <span className="text-xs text-muted-foreground">for each git fetch, ls-remote or push</span>
    </Commentable>
  );
}

/**
 * How a table's changes reach traffic: whether a merge deploys them, and in what words. A repo's `deploy` overrides the
 * `project`'s key by key, so a key it leaves out, or a version removes, shows the project's value.
 */
function Deploy({ path, label, deploy, project, inherited }: { path: string; label: string; deploy: DeploySpec | undefined; project?: DeploySpec; inherited: string }) {
  const review = useReview();
  const onMerge = deploy?.on_merge !== undefined || changedAt(review, `${path}.on_merge`);
  const how = deploy?.how !== undefined || changedAt(review, `${path}.how`);
  if (!onMerge && !how) {
    return (
      <Commentable as="span" target={value(path, label, "text")} className="text-muted-foreground">
        {inherited}
      </Commentable>
    );
  }
  const merges = deploy?.on_merge ?? project?.on_merge ?? false;
  const from = project !== undefined && deploy?.on_merge === undefined ? ", from the project" : "";
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {onMerge && (
        <Commentable as="span" target={value(`${path}.on_merge`, `${label} › on merge`, "bool", merges)}>
          {merges ? "deploys on merge" : "a merge does not deploy"}
          {from}
        </Commentable>
      )}
      {how && <Prose path={`${path}.how`} label={`${label} › how`} text={deploy?.how} fallback={project?.how === undefined ? "no words on how" : `from the project: ${project.how}`} />}
    </span>
  );
}

const REPO_OWN = [
  ["forge", "forge"],
  ["environment", "environment"],
  ["ci", "CI"],
  ["deploy", "deploy"],
  ["refresh_behind", "fresh pull requests"],
  ["git_network_timeout_seconds", "git time limit"],
  ["worktree", "worktree"],
] as const;

/** One [[repo]]: where it is and its checks, with every other setting behind a Settings disclosure that opens itself on a change, a comment or a finding. */
function RepoItem({ spec, repo, index, bbProjectNames }: { spec: Spec; repo: RepoSpec; index: number; bbProjectNames: Readonly<Record<string, string>> }) {
  const review = useReview();
  const { project, merge, checks } = spec;
  const at = `repo[${index}]`;
  const integration = merge.strategy === "integration";
  const own = REPO_OWN.filter(([key]) => repo[key] !== undefined);
  const open = REPO_OWN.some(([key]) => changedAt(review, `${at}.${key}`) || notedAt(review, `${at}.${key}`) || foundAt(review, `${at}.${key}`));
  const shown = (key: string, set: boolean) => set || changedAt(review, `${at}.${key}`);
  const base = repo.base ?? project.base;
  const projectEnvironment = spec.environment === undefined ? "a git worktree per thread" : `${spec.environment.provider}, from the project`;
  return (
    <li data-repo={repo.name} className="min-w-0 space-y-1 py-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Commentable as="span" target={{ paths: [at, `${at}.name`], label: `Repo ${repo.name}`, kind: "text" }} className="inline-flex items-center">
          <RepoChip name={repo.name} />
        </Commentable>
        <Commentable as="span" target={value(`${at}.project`, `${repo.name} › bb project`, "text", repo.project)} className="min-w-0 [overflow-wrap:anywhere]">
          <span data-repo-project>bb project {bbProjectNames[repo.project] ?? <code className={CODE}>{repo.project}</code>}</span>
        </Commentable>
        <Commentable as="span" target={value(`${at}.base`, `${repo.name} › base`, "text", base)} className="text-muted-foreground">
          base <code className={CODE}>{base}</code>
        </Commentable>
        {shown("remote", repo.remote !== undefined) && (
          <Commentable as="span" target={value(`${at}.remote`, `${repo.name} › remote`, "text", repo.remote ?? merge.remote)} className="text-muted-foreground">
            remote <code className={CODE}>{repo.remote ?? merge.remote}</code>
          </Commentable>
        )}
      </span>
      <span data-repo-checks={repo.name} className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Commentable as="span" target={value(`${at}.checks`, `${repo.name} › checks`, "command")} className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
          checks: {repo.checks === undefined ? "the project checks" : repo.checks.length === 0 ? "none: its tickets run only their own verify commands" : repo.checks.map((command) => <code key={command} className={CODE}>{command}</code>)}
        </Commentable>
        {integration && (
          <Commentable as="span" target={value(`${at}.after_merge`, `${repo.name} › after merge`, "command")} className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
            · after each merge:{" "}
            {repo.after_merge === undefined
              ? checks.after_merge.length === 0
                ? "nothing"
                : "the project's after-merge checks"
              : repo.after_merge.length === 0
                ? "nothing"
                : repo.after_merge.map((command) => <code key={command} className={CODE}>{command}</code>)}
          </Commentable>
        )}
      </span>
      {shown("protected", (repo.protected?.length ?? 0) > 0) && (
        <Commentable as="span" target={value(`${at}.protected`, `${repo.name} › protected`, "file")} className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          also protected:
          <DiffList
            path={`${at}.protected`}
            items={repo.protected ?? []}
            compact={false}
            render={(glob, mark) => (
              <code className={`${CODE} ${mark === "removed" ? "text-destructive-text line-through" : mark === "added" ? "ring-1 ring-success" : ""}`} data-removed={mark === "removed" || undefined}>
                {glob}
              </code>
            )}
          />
        </Commentable>
      )}
      <details data-repo-settings={repo.name} open={open} className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Settings · {own.length === 0 ? "all from the project" : `its own ${listText(own.map(([, name]) => name))}`}</summary>
        <dl className={`${ROWS} mt-1.5 pl-2`}>
          <ForgeRows path={`${at}.forge`} label={`${repo.name} › forge`} forge={repo.forge} inherited={`${FORGE_KINDS[merge.forge?.kind ?? "gh"]}, from the project`} />
          {repo.environment === undefined && !changedAt(review, `${at}.environment`) ? (
            <Row label="Environment" paths={[`${at}.environment`]}>
              <Commentable as="span" target={value(`${at}.environment`, `${repo.name} › environment`, "text")} className="text-muted-foreground">
                {projectEnvironment}
              </Commentable>
            </Row>
          ) : (
            <>
              <WorkerEnvironmentRows path={`${at}.environment`} label={`${repo.name} › environment`} environment={repo.environment} inherited={projectEnvironment} />
              <ReviewerEnvironmentRows path={`${at}.environment`} label={`${repo.name} › environment`} environment={repo.environment} />
            </>
          )}
          {(!integration || shown("ci", repo.ci !== undefined)) && (
            <Row label="CI" paths={[`${at}.ci`]}>
              <Commentable as="span" target={value(`${at}.ci`, `${repo.name} › ci`, "bool", repo.ci ?? checks.ci ?? true)} className={repo.ci === undefined ? "text-muted-foreground" : ""}>
                {repo.ci === undefined ? `${(checks.ci ?? true) ? "relies on CI" : "ignores CI"}, from the project` : ciText(repo.ci)}
              </Commentable>
            </Row>
          )}
          {(!integration || shown("deploy", repo.deploy !== undefined)) && (
            <Row label="Deploy" paths={[`${at}.deploy`]}>
              <Deploy path={`${at}.deploy`} label={`${repo.name} › deploy`} deploy={repo.deploy} project={spec.rollout?.deploy ?? {}} inherited={spec.rollout?.deploy === undefined ? "not said" : "the project's deploy"} />
            </Row>
          )}
          {(!integration || shown("refresh_behind", repo.refresh_behind !== undefined)) && (
            <Row label="Fresh pull requests" paths={[`${at}.refresh_behind`]}>
              {repo.refresh_behind === undefined ? (
                <Commentable as="span" target={value(`${at}.refresh_behind`, `${repo.name} › refresh behind`, "text")} className="text-muted-foreground">
                  {merge.refresh_behind === undefined ? "off, from the project" : `${plural(merge.refresh_behind, "commit")} behind, from the project`}
                </Commentable>
              ) : (
                <RefreshBehind path={`${at}.refresh_behind`} label={`${repo.name} › refresh behind`} n={repo.refresh_behind} base={base} />
              )}
            </Row>
          )}
          <Row label="Git time limit" paths={[`${at}.git_network_timeout_seconds`]}>
            {repo.git_network_timeout_seconds === undefined ? (
              <Commentable as="span" target={value(`${at}.git_network_timeout_seconds`, `${repo.name} › git network timeout seconds`, "number", merge.git_network_timeout_seconds ?? DEFAULT_GIT_SECONDS, { min: 30, max: 600, step: 30, unit: "s" })} className="text-muted-foreground">
                {merge.git_network_timeout_seconds === undefined ? `${DEFAULT_GIT_SECONDS} s, the default` : `${merge.git_network_timeout_seconds} s, from the project`}
              </Commentable>
            ) : (
              <GitTimeout path={`${at}.git_network_timeout_seconds`} label={`${repo.name} › git network timeout seconds`} seconds={repo.git_network_timeout_seconds} />
            )}
          </Row>
          {(integration || shown("worktree", repo.worktree !== undefined)) && (
            <Row label="Worktree" paths={[`${at}.worktree`]}>
              {repo.worktree === undefined ? (
                <span className="flex min-w-0 flex-col items-start gap-1">
                  <Commentable as="span" target={value(`${at}.worktree`, `${repo.name} › worktree`, "text")} className="text-muted-foreground">
                    {merge.worktree === undefined ? "Loom's own git worktree" : "the project's worktree"}
                  </Commentable>
                  {changedAt(review, `${at}.worktree`) && <Worktree path={`${at}.worktree`} label={`${repo.name} › worktree`} worktree={undefined} />}
                </span>
              ) : (
                <Worktree path={`${at}.worktree`} label={`${repo.name} › worktree`} worktree={repo.worktree} />
              )}
            </Row>
          )}
        </dl>
      </details>
    </li>
  );
}

function Worktree({ path, label, worktree }: { path: string; label: string; worktree: Spec["merge"]["worktree"] }) {
  const review = useReview();
  return (
    <span className="flex min-w-0 flex-col items-start gap-1">
      {(worktree?.plugin !== undefined || changedAt(review, `${path}.plugin`)) && (
        <span className="text-xs">
          <span className="text-muted-foreground">plugin </span>
          <Prose path={`${path}.plugin`} label={`${label} › plugin`} text={worktree?.plugin} fallback="none: a shell command" className="font-mono" />
        </span>
      )}
      <Command path={`${path}.command`} label={`${label} › command`} command={worktree?.command} />
    </span>
  );
}

/** The deploy order: how changes reach traffic, the stages in order, the milestones and the windows. Advice for the human; Loom holds nothing back for it. */
function DeployOrder({ spec }: { spec: Spec }) {
  const review = useReview();
  const rollout = spec.rollout;
  const repos = (spec.repo ?? []).map((repo, index) => ({ repo, at: `repo[${index}].deploy` })).filter(({ repo, at }) => repo.deploy !== undefined || changedAt(review, at));
  const faded = (path: string) => (review.only && !kept(review, [path]) ? "opacity-45" : "");
  const named = (path: string, key: string, label: string, className: string, children: ReactNode) => {
    const renamed = changeAt(review, `${path}.${key}`);
    return (
      <Commentable as="span" target={{ paths: [path, `${path}.${key}`], label, kind: "text" }} className={className}>
        {children}
        {renamed?.kind === "value" && (typeof renamed.before === "string" && renamed.before.length > 24 ? <del className="ml-1.5 text-xs font-normal text-destructive-text">{renamed.before}</del> : <WasBadge before={renamed.before} />)}
      </Commentable>
    );
  };
  const stages = rollout?.stage ?? [];
  const milestones = rollout?.milestone ?? [];
  const windows = rollout?.window ?? [];
  const goneStages = removedTables(review, "rollout.stage", stages.length);
  const goneMilestones = removedTables(review, "rollout.milestone", milestones.length);
  const goneWindows = removedTables(review, "rollout.window", windows.length);
  return (
    <div className="min-w-0 space-y-3">
      <p className="text-xs text-muted-foreground">Deploy order is advice for you: Loom tracks what is live and shows the next safe step on the Rollout tab, and holds no start, review or merge back for it.</p>
      {(rollout?.deploy !== undefined || changedAt(review, "rollout.deploy")) && (
        <dl className={ROWS}>
          <Row label="Changes deploy" paths={["rollout.deploy"]}>
            <Deploy path="rollout.deploy" label="How changes deploy" deploy={rollout?.deploy} inherited="not said" />
          </Row>
        </dl>
      )}
      {repos.length > 0 && (
        <section aria-label="Each repo's deploy">
          <h4 className={`${HEADING} mb-1`}>Repos that deploy their own way</h4>
          <ul className="space-y-1">
            {repos.map(({ repo, at }) => (
              <li key={repo.name} data-repo-deploy={repo.name} className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm ${faded(at)}`}>
                <Commentable as="span" target={value(at, `${repo.name} › deploy`, "text")} className="inline-flex items-center">
                  <RepoChip name={repo.name} />
                </Commentable>
                <Deploy path={at} label={`${repo.name} › deploy`} deploy={repo.deploy} project={rollout?.deploy ?? {}} inherited="the project's deploy" />
              </li>
            ))}
          </ul>
        </section>
      )}
      {stages.length + goneStages.length > 0 && (
        <section aria-label="Stages">
          <h4 className={`${HEADING} mb-1`}>Stages, in deploy order</h4>
          <ol className="space-y-1">
            {stages.map((stage, index) => {
              const at = `rollout.stage[${index}]`;
              const tickets = spec.ticket.filter((ticket) => ticket.rollout?.stage === stage.name).map((ticket) => ticket.ref);
              return (
                <li key={index} data-stage={stage.name} className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-border-seam px-2 py-1.5 text-sm ${faded(at)}`}>
                  {named(
                    at,
                    "name",
                    `Deploy stage ${stage.name}`,
                    "inline-flex items-baseline gap-1.5",
                    <>
                      <span className="text-xs text-subtle-foreground tabular-nums">{index + 1}</span>
                      <b className="font-mono text-xs font-semibold">{stage.name}</b>
                    </>,
                  )}
                  <Prose path={`${at}.goal`} label={`Deploy stage ${stage.name} › goal`} text={stage.goal} className="flex-1 basis-40" />
                  <Commentable as="span" target={value(`${at}.soak`, `Deploy stage ${stage.name} › soak`, "text", stage.soak)} className={`${CHIP} px-2 text-muted-foreground`}>
                    {stage.soak === undefined ? "no soak" : `soaks ${stage.soak}`}
                  </Commentable>
                  <span data-stage-tickets title={tickets.join(", ")} className="text-xs text-muted-foreground">
                    {plural(tickets.length, "ticket")}
                  </span>
                </li>
              );
            })}
            {goneStages.map((table) => (
              <RemovedRow key={table.at} table={table} label={`Deploy stage ${oldText(table, "name")} (removed)`}>
                <b className="font-mono text-xs">{oldText(table, "name")}</b> {oldText(table, "goal")}
              </RemovedRow>
            ))}
          </ol>
        </section>
      )}
      {milestones.length + goneMilestones.length > 0 && (
        <section aria-label="Milestones">
          <h4 className={`${HEADING} mb-1`}>Milestones no ticket delivers</h4>
          <ul className="space-y-1">
            {milestones.map((milestone, index) => {
              const at = `rollout.milestone[${index}]`;
              return (
                <li key={index} data-milestone={milestone.ref} className={`min-w-0 space-y-1 rounded-md border border-border-seam px-2 py-1.5 text-sm ${faded(at)}`}>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    {named(at, "ref", `Milestone ${milestone.ref}`, "font-mono text-xs font-semibold [overflow-wrap:anywhere]", milestone.ref)}
                    <Prose path={`${at}.title`} label={`Milestone ${milestone.ref} › title`} text={milestone.title} className="flex-1 basis-40" />
                    {(milestone.stage !== undefined || changedAt(review, `${at}.stage`)) && (
                      <Commentable as="span" target={value(`${at}.stage`, `Milestone ${milestone.ref} › stage`, "text", milestone.stage)} className={`${CHIP} px-2 text-muted-foreground`}>
                        {milestone.stage === undefined ? "gates no stage" : `gates ${milestone.stage}`}
                      </Commentable>
                    )}
                  </span>
                  {milestone.check === undefined && changeAt(review, `${at}.check`) === undefined ? (
                    <p className="text-xs text-muted-foreground">No check command: you mark it live when it holds.</p>
                  ) : (
                    <Command path={`${at}.check`} label={`Milestone ${milestone.ref} › check`} command={milestone.check} />
                  )}
                </li>
              );
            })}
            {goneMilestones.map((table) => (
              <RemovedRow key={table.at} table={table} label={`Milestone ${oldText(table, "ref")} (removed)`}>
                <b className="font-mono text-xs">{oldText(table, "ref")}</b> {oldText(table, "title")}
              </RemovedRow>
            ))}
          </ul>
        </section>
      )}
      {windows.length + goneWindows.length > 0 && (
        <section aria-label="Windows">
          <h4 className={`${HEADING} mb-1`}>Windows: freezes and deploy restrictions</h4>
          <ul className="space-y-1">
            {windows.map((window, index) => {
              const at = `rollout.window[${index}]`;
              return (
                <li key={index} data-window={window.title} className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md border border-border-seam px-2 py-1.5 text-sm ${faded(at)}`}>
                  {named(at, "title", `Deploy window ${window.title}`, "font-semibold [overflow-wrap:anywhere]", window.title)}
                  <span className="inline-flex flex-wrap items-baseline gap-1 text-xs tabular-nums">
                    <Commentable as="span" target={value(`${at}.from`, `Deploy window ${window.title} › from`, "text", window.from)}>
                      {window.from}
                    </Commentable>
                    to
                    <Commentable as="span" target={value(`${at}.to`, `Deploy window ${window.title} › to`, "text", window.to)}>
                      {window.to}
                    </Commentable>
                  </span>
                  {(window.note !== undefined || changedAt(review, `${at}.note`)) && (
                    <Prose path={`${at}.note`} label={`Deploy window ${window.title} › note`} text={window.note} fallback="no note" className="basis-full text-xs text-muted-foreground" />
                  )}
                </li>
              );
            })}
            {goneWindows.map((table) => (
              <RemovedRow key={table.at} table={table} label={`Deploy window ${oldText(table, "title")} (removed)`}>
                <b>{oldText(table, "title")}</b> {oldText(table, "from")} to {oldText(table, "to")}
              </RemovedRow>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const HOOK_READERS = { planner: "The planner, when it happens", worker: "Each worker, in its brief" };

/** The spec's [[hook]] tables: on which event, what the planner or each worker is told, and the command Loom runs. */
function HookList({ spec }: { spec: Spec }) {
  const review = useReview();
  const hooks = spec.hook ?? [];
  const gone = removedTables(review, "hook", hooks.length);
  const faded = (path: string) => (review.only && !kept(review, [path]) ? "opacity-45" : "");
  const eventName = (on: string) => HOOK_EVENT_NAMES[on as keyof typeof HOOK_EVENT_NAMES] ?? on;
  return (
    <div className="min-w-0 space-y-2">
      <p className="text-xs text-muted-foreground">When each event happens, Loom tells the planner what to do, or puts it in each worker's brief, and runs the command on the project's machine. It checks neither and holds nothing back for them.</p>
      <ol className="space-y-1">
        {hooks.map((hook, index) => {
          const at = `hook[${index}]`;
          const label = `Hook ${index + 1}`;
          return (
            <li key={index} data-hook={index} className={`min-w-0 space-y-1.5 rounded-md border border-border-seam px-2 py-1.5 text-sm ${faded(at)}`}>
              <Commentable as="span" target={{ paths: [`${at}.on`], label: `${label} › on`, kind: "enum", value: hook.on, options: HOOK_EVENTS, names: HOOK_EVENT_NAMES }} className="font-semibold [overflow-wrap:anywhere]">
                When {eventName(hook.on)}
              </Commentable>
              {(hook.tell !== undefined || changedAt(review, `${at}.tell`)) && (
                <Part label="Tell" paths={[`${at}.tell`]}>
                  <Prose path={`${at}.tell`} label={`${label} › tell`} text={hook.tell} fallback="nothing to tell" className="block whitespace-pre-line" />
                </Part>
              )}
              {(hook.tell !== undefined || hook.to !== undefined || changedAt(review, `${at}.to`)) && (
                <Part label="Who reads it" paths={[`${at}.to`]}>
                  <Choice path={`${at}.to`} label={`${label} › to`} value={hook.to ?? "planner"} options={["planner", "worker"]} names={HOOK_READERS} />
                </Part>
              )}
              {(hook.run !== undefined || changedAt(review, `${at}.run`)) && (
                <Part label="Run" paths={[`${at}.run`]}>
                  <Command path={`${at}.run`} label={`${label} › run`} command={hook.run} />
                </Part>
              )}
            </li>
          );
        })}
        {gone.map((table) => (
          <RemovedRow key={table.at} table={table} label={`Hook ${table.index + 1} (removed)`}>
            When {eventName(oldText(table, "on"))}
          </RemovedRow>
        ))}
      </ol>
    </div>
  );
}

/** How Loom runs the project: merging, workers, reviewers, checks, the scope guard, repos, the deploy order, hooks, and limits and triage. */
export function SettingsSection({ spec, bbProjectNames, onShowAll, onJump }: { spec: Spec; bbProjectNames: Readonly<Record<string, string>>; onShowAll(): void; onJump(section: "tickets" | "guardrails"): void }) {
  const review = useReview();
  const { merge, agents, review: rules, checks, scope, budget, project } = spec;
  const repos = spec.repo ?? [];
  const integration = merge.strategy === "integration";
  const worker = agents.worker;
  const reviewer = agents.reviewer;
  const ownVerify = spec.ticket.filter((ticket) => ticket.verify.length > 0).length;
  const skipped = integration ? checks.commands.filter((command) => !checks.after_merge.includes(command)) : [];
  const permission = { "accept-edits": "edits only", auto: "auto", full: "full" };
  const deployPaths = ["rollout", ...repos.map((_, index) => `repo[${index}].deploy`)];
  const goneRepos = removedTables(review, "repo", repos.length);
  const drafts = (
    <Row label="Drafts" paths={["merge.draft"]}>
      <Commentable as="span" target={value("merge.draft", "Draft pull requests", "bool", merge.draft)}>
        {merge.draft ? "Opened as drafts" : "Opened ready for review"}
      </Commentable>
    </Row>
  );

  const cards: SettingsCard[] = [
    {
      id: "merge",
      title: "Merging",
      paths: ["merge", "project.base"],
      wide: hasForgeParts(merge.forge),
      body: (
        <>
          <p className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="rounded-md border border-border-seam px-2 py-1">{spec.ticket.length} ticket {spec.ticket.length === 1 ? "branch" : "branches"}</span>
            <span aria-hidden className="text-subtle-foreground">→</span>
            {integration ? (
              <>
                <Commentable as="span" target={value("merge.branch", "Integration branch", "text", merge.branch)} className="rounded-md border border-primary px-2 py-1 font-mono">
                  {merge.branch}
                </Commentable>
                <span aria-hidden className="text-subtle-foreground">→</span>
              </>
            ) : (
              <>
                <span className="rounded-md border border-primary px-2 py-1">a pull request each</span>
                <span aria-hidden className="text-subtle-foreground">→</span>
              </>
            )}
            <Commentable as="span" target={value("project.base", "Base branch", "text", project.base)} className="rounded-md border border-border-seam px-2 py-1 font-mono">
              {project.base}
            </Commentable>
          </p>
          <dl className={ROWS}>
            <Row label="Strategy" paths={["merge.strategy"]}>
              <Choice path="merge.strategy" label="Merge strategy" value={merge.strategy} options={["integration", "pr"]} names={{ integration: "Integration branch", pr: "Pull request per ticket" }} />
            </Row>
            {integration ? (
              <>
                <Row label="Landing" paths={["merge.strategy"]}>
                  <span className="text-xs text-muted-foreground">
                    You land it with <code className={`${CODE} whitespace-nowrap`}>bb loom land</code>: {repos.length > 0 ? "one pull request per repo" : "one pull request"}, or onto {repos.length > 0 ? "each base" : project.base} with <code className={`${CODE} whitespace-nowrap`}>--direct</code>.
                  </span>
                </Row>
                {drafts}
              </>
            ) : (
              <>
                <Row label="Written by" paths={["merge.describe"]}>
                  <Choice path="merge.describe" label="Who writes the pull request" value={merge.describe ?? "worker"} options={["worker", "loom"]} names={{ worker: "The worker", loom: "Loom's template" }} />
                </Row>
                {drafts}
                <Row label="Commits" paths={["merge.squash"]}>
                  <Commentable as="span" target={value("merge.squash", "One commit per pull request", "bool", merge.squash ?? true)}>
                    {(merge.squash ?? true) ? "One commit per pull request" : "The branch as it is"}
                  </Commentable>
                </Row>
                <Row label="Fix rounds" paths={["merge.max_fix_rounds"]}>
                  <Commentable as="span" target={value("merge.max_fix_rounds", "Fix rounds", "number", merge.max_fix_rounds ?? 5, { min: 0, max: 20 })}>
                    <b className="tabular-nums">{merge.max_fix_rounds ?? 5}</b> <span className="text-xs text-muted-foreground">then the ticket blocks</span>
                  </Commentable>
                </Row>
                {(merge.checks_queued_minutes !== undefined || changedAt(review, "merge.checks_queued_minutes")) && (
                  <Row label="Queued checks" paths={["merge.checks_queued_minutes"]}>
                    <Commentable as="span" target={value("merge.checks_queued_minutes", "Stop waiting for queued checks", merge.checks_queued_minutes === undefined ? "text" : "number", merge.checks_queued_minutes, { min: 0, max: 1440 })}>
                      {merge.checks_queued_minutes === undefined ? (
                        <span className="text-xs text-muted-foreground">Loom's own setting</span>
                      ) : merge.checks_queued_minutes === 0 ? (
                        <span className="text-xs text-muted-foreground">Failed checks wait for queued ones</span>
                      ) : (
                        <>
                          <b className="tabular-nums">{merge.checks_queued_minutes} min</b> <span className="text-xs text-muted-foreground">then they stop holding failed checks</span>
                        </>
                      )}
                    </Commentable>
                  </Row>
                )}
                {(merge.checks_near_done_percent !== undefined || changedAt(review, "merge.checks_near_done_percent")) && (
                  <Row label="Running checks" paths={["merge.checks_near_done_percent"]}>
                    <Commentable as="span" target={value("merge.checks_near_done_percent", "Wait for running checks this far along", merge.checks_near_done_percent === undefined ? "text" : "number", merge.checks_near_done_percent, { min: 0, max: 100 })}>
                      {merge.checks_near_done_percent === undefined ? (
                        <span className="text-xs text-muted-foreground">Loom's own setting</span>
                      ) : merge.checks_near_done_percent === 0 ? (
                        <span className="text-xs text-muted-foreground">Failed checks wait for every running one</span>
                      ) : (
                        <>
                          <b className="tabular-nums">{merge.checks_near_done_percent}%</b> <span className="text-xs text-muted-foreground">done, or failed checks go without them</span>
                        </>
                      )}
                    </Commentable>
                  </Row>
                )}
                <Row label="Stacking" paths={["merge.stack"]}>
                  <Commentable as="span" target={value("merge.stack", "Stacked pull requests", "bool", merge.stack ?? true)}>
                    {(merge.stack ?? true) ? "A ticket starts on its dependencies' open pull requests" : "A ticket waits for its dependencies to merge"}
                  </Commentable>
                </Row>
                <Row label="Idle workers" paths={["merge.release_workers"]}>
                  <Commentable as="span" target={value("merge.release_workers", "Release idle workers", "bool", merge.release_workers ?? true)}>
                    {(merge.release_workers ?? true) ? "Released while their pull requests wait, so bb frees their environments" : "Kept, with their environments, until their pull requests merge"}
                  </Commentable>
                </Row>
                <Row label="Fresh pull requests" paths={["merge.refresh_behind"]}>
                  <RefreshBehind path="merge.refresh_behind" label="Keep pull requests fresh" n={merge.refresh_behind} base={project.base} />
                </Row>
              </>
            )}
            {(merge.remote !== "origin" || changedAt(review, "merge.remote")) && (
              <Row label="Remote" paths={["merge.remote"]}>
                <Commentable as="span" target={value("merge.remote", "Remote", "text", merge.remote)} className="font-mono text-xs">
                  {merge.remote}
                </Commentable>
              </Row>
            )}
            {(merge.worktree !== undefined || changedAt(review, "merge.worktree")) && (
              <Row label="Worktree" paths={["merge.worktree"]}>
                <Worktree path="merge.worktree" label="Integration worktree" worktree={merge.worktree} />
              </Row>
            )}
            <Row label="Git time limit" paths={["merge.git_network_timeout_seconds"]}>
              <GitTimeout path="merge.git_network_timeout_seconds" label="Git network time limit" seconds={merge.git_network_timeout_seconds} />
            </Row>
            {(merge.forge !== undefined || changedAt(review, "merge.forge")) && <ForgeRows path="merge.forge" label="Forge" forge={merge.forge} inherited="GitHub through gh, the default" />}
          </dl>
        </>
      ),
    },
    {
      id: "workers",
      title: "Workers",
      note: "write the code",
      paths: ["agents.worker", "agents.max_workers", "agents.ticket_timeout_minutes", "environment.provider", "environment.inputs", "environment.machine"],
      body: (
        <dl className={ROWS}>
          <Row label="Model" paths={["agents.worker.model", "agents.worker.provider"]}>
            <Commentable as="span" target={{ paths: ["agents.worker.model", "agents.worker.provider"], label: "Worker model", kind: "text" }}>
              <Model agent={worker} />
            </Commentable>
          </Row>
          <Row label="Reasoning" paths={["agents.worker.reasoning"]}>
            <Commentable as="span" target={value("agents.worker.reasoning", "Worker reasoning", "text", worker.reasoning)}>
              {worker.reasoning ?? <span className="text-muted-foreground">the model's default</span>}
            </Commentable>
          </Row>
          <Row label="At the same time" paths={["agents.max_workers"]}>
            <Commentable as="span" target={value("agents.max_workers", "Workers at the same time", "number", agents.max_workers, { min: 1, max: 8 })}>
              <Slots n={agents.max_workers} max={8} />
            </Commentable>
          </Row>
          <Row label="Time per ticket" paths={["agents.ticket_timeout_minutes"]}>
            <Commentable as="span" target={value("agents.ticket_timeout_minutes", "Time per ticket", "number", agents.ticket_timeout_minutes, { min: 10, max: 1440, step: 30, unit: "min" })}>
              <b>{minutes(agents.ticket_timeout_minutes)}</b>
            </Commentable>
          </Row>
          <Row label="Permissions" paths={["agents.worker.permission_mode"]}>
            <Choice path="agents.worker.permission_mode" label="Worker permissions" value={worker.permission_mode} options={["accept-edits", "auto", "full"]} names={permission} />
          </Row>
          {(spec.environment !== undefined || changedAt(review, "environment.provider")) && <WorkerEnvironmentRows path="environment" label="Environment" environment={spec.environment} inherited="a git worktree per thread" />}
        </dl>
      ),
    },
    {
      id: "reviewers",
      title: "Reviewers",
      note: "approve each ticket",
      paths: ["agents.reviewer", "agents.max_reviewers", "review.approvals", "review.max_rounds", "environment.reviewer"],
      body: (
        <dl className={ROWS}>
          <Row label="Model" paths={["agents.reviewer.model", "agents.reviewer.provider"]}>
            <Commentable as="span" target={{ paths: ["agents.reviewer.model", "agents.reviewer.provider"], label: "Reviewer model", kind: "text" }}>
              <Model agent={reviewer} />
            </Commentable>
          </Row>
          <Row label="Reasoning" paths={["agents.reviewer.reasoning"]}>
            <Commentable as="span" target={value("agents.reviewer.reasoning", "Reviewer reasoning", "text", reviewer.reasoning)}>
              {reviewer.reasoning ?? <span className="text-muted-foreground">the model's default</span>}
            </Commentable>
          </Row>
          <Row label="At the same time" paths={["agents.max_reviewers"]}>
            <Commentable as="span" target={value("agents.max_reviewers", "Reviewers at the same time", "number", agents.max_reviewers, { min: 1, max: 8 })}>
              <Slots n={agents.max_reviewers} max={8} />
            </Commentable>
          </Row>
          <Row label="Approvals needed" paths={["review.approvals"]}>
            <Commentable as="span" target={value("review.approvals", "Approvals needed", "number", rules.approvals, { min: 1, max: 3 })}>
              <b className="tabular-nums">{rules.approvals}</b> <span className="text-xs text-muted-foreground">of up to 3</span>
            </Commentable>
          </Row>
          <Row label="Review rounds" paths={["review.max_rounds"]}>
            <Commentable as="span" target={value("review.max_rounds", "Review rounds", "number", rules.max_rounds, { min: 1, max: 10 })}>
              <b className="tabular-nums">up to {rules.max_rounds}</b> <span className="text-xs text-muted-foreground">then the ticket blocks</span>
            </Commentable>
          </Row>
          <Row label="Permissions" paths={["agents.reviewer.permission_mode"]}>
            <Choice path="agents.reviewer.permission_mode" label="Reviewer permissions" value={reviewer.permission_mode} options={["accept-edits", "auto", "full"]} names={permission} />
          </Row>
          <Row label="What they check" paths={["review.rubric"]}>
            <button type="button" className="cursor-pointer text-xs text-primary underline-offset-2 hover:underline" onClick={() => onJump("guardrails")}>
              {rules.rubric.length === 0 ? "no rubric: the ticket's criteria only" : `${plural(rules.rubric.length, "rubric line")} ↓`}
            </button>
          </Row>
          {(spec.environment !== undefined || changedAt(review, "environment.reviewer")) && <ReviewerEnvironmentRows path="environment" label="Environment" environment={spec.environment} />}
        </dl>
      ),
    },
    {
      id: "checks",
      title: "Checks",
      note: "commands that must pass",
      paths: ["checks"],
      wide: true,
      body: (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            On every ticket{repos.length > 0 ? " in a repo without checks of its own" : ""}, before review
            <Commentable as="span" target={value("checks.timeout_minutes", "Check time limit", "number", checks.timeout_minutes, { min: 1, max: 29, unit: "min" })} className={`${CHIP} px-2 text-foreground`}>
              {checks.timeout_minutes} min limit
            </Commentable>
          </p>
          {checks.commands.length === 0 && (
            <Commentable target={value("checks.commands", "Ticket checks", "command")} className="text-sm text-muted-foreground">
              No project checks: each ticket runs only its own verify commands.
            </Commentable>
          )}
          {(checks.commands.length > 0 || changeAt(review, "checks.commands") !== undefined) && <Steps path="checks.commands" label="Ticket check" commands={checks.commands} />}
          {(integration || checks.after_merge.length > 0 || changedAt(review, "checks.after_merge")) && (
            <>
              <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
                On the integration branch after each merge
                {skipped.length > 0 && checks.after_merge.length > 0 && <span className={`${CHIP} px-2`}>skips {skipped.length === 1 ? "1 ticket check" : `${skipped.length} ticket checks`}</span>}
              </p>
              {checks.after_merge.length === 0 && (
                <Commentable target={value("checks.after_merge", "After-merge checks", "command")} className="text-sm text-muted-foreground">
                  Nothing runs after a merge.
                </Commentable>
              )}
              {(checks.after_merge.length > 0 || changeAt(review, "checks.after_merge") !== undefined) && <Steps path="checks.after_merge" label="After-merge check" commands={checks.after_merge} missing={skipped} />}
            </>
          )}
          {(!integration || checks.ci !== undefined || changedAt(review, "checks.ci")) && (
            <p className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
              CI{repos.length > 0 ? " in a repo without a ci of its own" : ""}
              <Commentable as="span" target={value("checks.ci", "Rely on CI", "bool", checks.ci ?? true)} className="text-foreground">
                {ciText(checks.ci ?? true)}
              </Commentable>
            </p>
          )}
          <p className="pt-1 text-xs text-muted-foreground">
            Plus each ticket's own verify commands: <b className="text-foreground">{ownVerify === spec.ticket.length ? "every ticket" : `${ownVerify} of ${spec.ticket.length} tickets`}</b> {ownVerify === 1 ? "has" : "have"} some.{" "}
            <button type="button" className="cursor-pointer text-primary underline-offset-2 hover:underline" onClick={() => onJump("tickets")}>
              See the tickets ↓
            </button>
          </p>
        </div>
      ),
    },
    {
      id: "scope",
      title: "Scope guard",
      paths: ["scope"],
      body: (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">When a worker changes a file outside its ticket's scope</p>
          <Choice path="scope.enforce" label="Scope enforcement" value={scope.enforce} options={["warn", "reject"]} names={{ warn: "Warn the reviewer", reject: "Reject the work" }} />
          <p className="pt-1 text-xs text-muted-foreground">No ticket may change{repos.length > 0 ? ", in any repo" : ""}</p>
          <div className="flex flex-wrap gap-1">
            {scope.protected.length === 0 && (
              <Commentable as="span" target={value("scope.protected", "Protected paths", "file")} className="text-sm text-muted-foreground">
                No protected paths.
              </Commentable>
            )}
            {(scope.protected.length > 0 || changeAt(review, "scope.protected") !== undefined) && (
              <DiffList
                path="scope.protected"
                items={scope.protected}
                compact={false}
                render={(glob, mark, index) =>
                  mark === "removed" ? (
                    <span data-removed className="rounded bg-destructive-text/10 px-1.5 font-mono text-xs text-destructive-text line-through">
                      {glob}
                    </span>
                  ) : (
                    <Commentable as="span" target={value(`scope.protected[${index}]`, `Protected path ${glob}`, "file")} className={`rounded px-1.5 font-mono text-xs [overflow-wrap:anywhere] ${mark === "added" ? "bg-success/15 ring-1 ring-success" : "bg-surface-recessed"}`}>
                      {glob}
                    </Commentable>
                  )
                }
              />
            )}
          </div>
        </div>
      ),
    },
    ...(repos.length === 0 && goneRepos.length === 0
      ? []
      : [
          {
            id: "repos",
            title: `Repos · ${repos.length}`,
            paths: ["repo"],
            full: true,
            body: (
              <ul className="divide-y divide-border-seam">
                {repos.map((repo, index) => (
                  <RepoItem key={repo.name} spec={spec} repo={repo} index={index} bbProjectNames={bbProjectNames} />
                ))}
                {goneRepos.map((table) => (
                  <RemovedRow key={table.at} table={table} label={`Repo ${oldText(table, "name")} (removed)`}>
                    <b className="font-mono text-xs">{oldText(table, "name")}</b> bb project {bbProjectNames[oldText(table, "project")] ?? oldText(table, "project")}
                  </RemovedRow>
                ))}
              </ul>
            ),
          },
        ]),
    ...(spec.rollout === undefined && !repos.some((repo) => repo.deploy !== undefined) && !deployPaths.some((path) => changedAt(review, path))
      ? []
      : [{ id: "deploy", title: "Deploy order", note: "when each change may reach traffic", paths: deployPaths, full: true, body: <DeployOrder spec={spec} /> }]),
    ...(spec.hook === undefined && !changedAt(review, "hook")
      ? []
      : [{ id: "hooks", title: `Hooks · ${spec.hook?.length ?? 0}`, note: "what happens after each event", paths: ["hook"], full: true, body: <HookList spec={spec} /> }]),
    {
      id: "limits",
      title: "Limits and triage",
      note: "when Loom stops and asks",
      paths: ["budget", "agents.triage"],
      full: true,
      body: (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-2">
          {(
            [
              ["budget.max_attempts", "Attempts per ticket", String(budget.max_attempts), "then it blocks", { kind: "number", value: budget.max_attempts, min: 1, max: 10 }],
              ["budget.max_check_failures", "Failed check runs", String(budget.max_check_failures), "per ticket, then it blocks", { kind: "number", value: budget.max_check_failures, min: 1, max: 20 }],
              ["budget.max_tokens", "Token budget", budget.max_tokens === undefined ? "No limit" : budget.max_tokens.toLocaleString("en-US"), "for the whole project", { kind: "text" }],
              ["budget.deadline", "Deadline", budget.deadline ?? "None", "Loom pauses the project after it", { kind: "text" }],
              ["agents.triage", "Triage", agents.triage ? "On" : "Off", agents.triage ? "the planner answers blocked tickets" : "blocked tickets wait for you", { kind: "bool", value: agents.triage }],
            ] as const
          ).map(([path, label, shown, note, target]) => {
            const faded = review.only && !kept(review, [path]);
            return (
              <Commentable key={path} target={{ paths: [path], label, ...target }} className={`rounded-md border border-border-seam bg-surface-recessed/40 px-2.5 py-2 ${faded ? "opacity-45" : ""}`}>
                <span className="block text-[11px] text-muted-foreground">{label}</span>
                <span className={`block text-base font-semibold tabular-nums ${shown === "No limit" || shown === "None" ? "text-sm font-medium text-subtle-foreground" : ""}`}>{shown}</span>
                <span className="block text-[11px] text-subtle-foreground">{note}</span>
              </Commentable>
            );
          })}
        </div>
      ),
    },
  ];

  const shown = cards.filter((card) => kept(review, card.paths));
  const hidden = cards.length - shown.length;
  return (
    <>
      {shown.length > 0 && (
        // Its own container: beside the review panel, the spec page is much wider than this column.
        <div className="@container">
          <div data-settings-grid className="grid grid-flow-row-dense gap-3 @xl:grid-cols-2 @5xl:grid-cols-3">
            {shown.map((card) => (
              <Card key={card.id} card={card} />
            ))}
          </div>
        </div>
      )}
      {hidden > 0 && (
        <p data-hidden-line className="mt-3 flex items-center gap-2 rounded-md border border-dashed border-border-seam px-3 py-2 text-xs text-muted-foreground">
          {hidden === cards.length ? "No setting changed." : `${plural(hidden, "group")} of settings did not change.`}
          <button type="button" className={`${BUTTON} ml-auto`} onClick={onShowAll}>
            Show {hidden === 1 ? "it" : "them"}
          </button>
        </p>
      )}
    </>
  );
}

