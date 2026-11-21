import type { Member } from "../../shared/schema";
import type { ThreadDecor } from "../../shared/contract";
import { memberIdentityLabel } from "../../shared/identity";
import { pullRequestVerified } from "../../shared/pull-request";
import { Crest } from "./crest";
import { memberIdentity, type Registry } from "./registry";
import { PlacementFacts } from "./placement";
import "./member-identity.css";

type MemberScope = ThreadDecor["scope"];
export type MemberIdentityProps = { member: Member; registry: Registry; scope?: MemberScope; compact?: boolean; finished?: boolean; violations?: ThreadDecor["violations"]; variant?: "chips"; onScopeDetails?: () => void };

function guardWords(member: Member, scope: MemberScope, finished: boolean) {
  if (!scope && member.role === "solo") return "no Tavern guard (started by you)";
  if (finished) return member.guardPosture ? member.guardPosture.mode === "pre-exec" ? "enforced during the run" : "watched during the run" : "guard state not recorded";
  const mode = scope?.mode ?? scope?.scope?.mode;
  const posture = scope?.guardPosture ?? member.guardPosture;
  if (mode === "off") return "off";
  if (mode === "watch" || posture?.mode === "detection-only") return "watch only";
  if (!scope?.armed || !scope.scope || scope.error || scope.guard?.stale || scope.guard?.installed === false) return "not armed yet";
  return scope.scope.preset === "open" ? "only protected files guarded" : "enforced";
}

function writeWords(scope: NonNullable<MemberScope>["scope"]) {
  if (!scope) return "not recorded";
  const { mode, allow } = scope.writes;
  if (mode === "any") return "anywhere";
  const under = (path: string, root: string | undefined) => !!root && (path === root || path.startsWith(`${root}/`));
  const isTemp = (p: string) => p === "${tmp}" || /^\/(?:private\/)?tmp(?:\/|$)/.test(p) || under(p, scope.env.variables.TMPDIR);
  const isStorage = (p: string) => scope.env.variables.BB_THREAD_STORAGE ? under(p, scope.env.variables.BB_THREAD_STORAGE) : p === "${threadStorage}" || p.includes("/thread-storage/");
  const temp = allow.some(isTemp), storage = allow.some(isStorage);
  if (mode === "worktree") return temp && storage ? "its worktree, temp and its own storage" : "its worktree and listed paths";
  if (temp && storage && allow.every(p => isTemp(p) || isStorage(p))) return "temp and its own storage";
  return allow.length ? "listed paths" : "nowhere";
}

export function memberIdentityWords(member: Member, registry: Registry, scope?: MemberScope, finished = false) {
  const identity = memberIdentity(registry, member);
  const name = memberIdentityLabel(member, registry);
  const cls = identity ? `${identity.cls.label} (${identity.cls.plain})` : member.classId;
  return `${name}, ${cls} · scope: ${scope?.scope?.preset ?? "not recorded"} · ${guardWords(member, scope, finished)}`;
}

export function MemberIdentity({ member, registry, scope, compact = false, finished = false, violations = [], variant, onScopeDetails }: MemberIdentityProps) {
  const identity = memberIdentity(registry, member);
  const name = memberIdentityLabel(member, registry);
  const sc = scope?.scope;
  const guard = guardWords(member, scope, finished);
  const alerts = (scope?.problems?.length ?? 0) + violations.length + (scope?.error ? 1 : 0) + (variant === "chips" && scope?.pendingAskId ? 1 : 0);
  const chips = variant === "chips";
  return <div className={`member-identity ${compact ? "compact" : ""}${chips ? " chips" : ""}`} role={chips ? "group" : undefined} data-part="MemberIdentity" aria-label={`${name}, member identity`}>
    {!compact && identity && <Crest {...identity} size={32} />}
    <div className="mi-words">
      <div className="mi-name"><b>{name}</b><span> · {identity?.cls.label ?? member.classId}{identity && ` (${identity.cls.plain})`}</span></div>
      {!compact && identity?.cls.description && <p className="mi-role">{identity.cls.description}</p>}
      {chips ? <div className="mi-chips" role="group" aria-label="Scope and guard state">{[
        ["Scope", sc?.preset ?? "not recorded"], ["Guard", guard], ["Writes", writeWords(sc ?? null)],
        ["Network", sc ? sc.network === "any" ? "allowed" : "none" : "not recorded"],
        ["GitHub", sc ? ({none:"none",read:"reads only","draft-pr-only":"reads and draft pull requests"} as const)[sc.github] : "not recorded"],
      ].map(([label, value]) => <span className="tag mi-chip" key={label}><span className="mi-chip-label">{label}</span><span>{value}</span></span>)}
        {alerts > 0 && (onScopeDetails ? <button type="button" className="tag mi-chip mi-alert act" onClick={onScopeDetails} aria-label={`${alerts} scope ${alerts === 1 ? "alert" : "alerts"}. Open scope details`}>{alerts} scope {alerts === 1 ? "alert" : "alerts"}</button> : <span className="tag mi-chip mi-alert" role="status">{alerts} scope {alerts === 1 ? "alert" : "alerts"}</span>)}
      </div> : <><p className="mi-scope">scope: {sc?.preset ?? "not recorded"} · {guard}</p>
      {!compact && <p className="mi-permissions">writes: {writeWords(sc ?? null)} · network: {sc ? sc.network === "any" ? "allowed" : "none" : "not recorded"} · GitHub: {sc ? ({none:"none",read:"reads only","draft-pr-only":"reads and draft pull requests"} as const)[sc.github] : "not recorded"}</p>}
      {alerts > 0 && <p className="mi-alert" role="status">{alerts} scope {alerts === 1 ? "alert" : "alerts"}{scope?.error ? `: ${scope.error}` : ""}</p>}</>}
      {member.pullRequests?.map(pr => <p key={pr.id}>Draft PR: <a href={pr.url} target="_blank" rel="noreferrer">{pr.url}</a> ({pr.state}; owner: {pr.owner}; {pullRequestVerified(pr) ? "head verified" : "head not verified"})</p>)}
      <PlacementFacts placement={member.placement} memberName={name} variant={chips ? "card" : "row"} />
    </div>
  </div>;
}
