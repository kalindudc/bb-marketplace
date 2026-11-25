// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { evaluate } from "../../src/scope/engine";
import { prepareCall } from "../../src/scope/prepare";
import { bindPaths } from "../../src/scope/paths";
import { scopeForClass } from "../../src/scope/presets";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tavern-round5-")); roots.push(root);
  for (const path of ["work/src", "work/a", "scratch", "storage", "outside"]) mkdirSync(join(root, path), { recursive: true });
  const cwd = join(root, "work");
  const check = (source: string, role = "smith", deny: string[] = []) => {
    const scope = bindPaths(scopeForClass(role), { home: root, worktree: cwd, tmp: [join(root, "scratch")], scopesDir: join(root, "scopes"), threadStorage: join(root, "storage") });
    scope.writes.deny.push(...deny);
    const command = source.replaceAll("OUTSIDE", join(root, "outside")).replaceAll("WORKTREE", cwd);
    return evaluate(scope, prepareCall({ kind: "bash", toolName: "bash", cwd, input: { command } }, { scope }));
  };
  return { root, cwd, check };
}
it.each(["ranger", "smith"])("passes ordinary workloads with non-literal and array assignment targets for %s", role => {
  for (const command of ['R=TMPDIR; export "$R=OUTSIDE"; echo x > "$TMPDIR/x"', 'R=TMPDIR; declare "$R=OUTSIDE"; echo x > "$TMPDIR/x"', 'R=TMPDIR; read -r "$R"; echo x > "$TMPDIR/x"', 'R=TMPDIR; printf -v "$R" %s OUTSIDE; echo x > "$TMPDIR/x"', 'printf -v TMPDIR[0] %s OUTSIDE; echo x > "$TMPDIR/x"', 'mapfile -t TMPDIR; echo x > "$TMPDIR/x"', 'readarray -t TMPDIR; echo x > "$TMPDIR/x"', 'declare -n R; R=TMPDIR; R=OUTSIDE; echo x > "$TMPDIR/x"', 'R=TMPDIR; eval "$R=OUTSIDE"; echo x > "$TMPDIR/x"']) expect(fixture().check(command, role).allow, command).toBe(true);
});
it.each(["cd OUTSIDE || cd WORKTREE || exit; touch x", "cd OUTSIDE && false || exit \"$(touch x)\"; touch x", "cd OUTSIDE || cd WORKTREE || return; touch x", "cd OUTSIDE || cd missing || exit 1; npm test", "cd WORKTREE || cd OUTSIDE || exit; touch x"])("does not refuse ordinary work after a cd fallback: %s", source => expect(fixture().check(source).allow).toBe(true));
it.each(["cd missing || cd a || exit; touch x", "cd a || cd missing || exit; touch x", "cd missing || cd a || exit 1; npm test"])("evaluates cd fallback paths relative to the pre-failure cwd: %s", source => expect(fixture().check(source).allow).toBe(true));
it.each(["mktemp -p OUTSIDE", "mktemp --tmpdir=OUTSIDE", "mktemp -pOUTSIDE", "mktemp OUTSIDE/x.XXXX", "mktemp -d -p OUTSIDE x.XXXX"])("passes ordinary Smith mktemp arguments: %s", source => expect(fixture().check(source).allow).toBe(true));
it.each(['tmp=$(mktemp -d) && cp src/a.ts "$tmp/"', 'tmp="$(mktemp -d)" && cp src/a.ts "$tmp/report"', 'echo x > "$(mktemp)"'])("allows proven Ranger temporary outputs: %s", source => expect(fixture().check(source, "ranger").allow).toBe(true));
it.each(['tmp=$(mktemp -d) && tmp[0]=OUTSIDE && cp src/a.ts "$tmp/"', "echo x > \"\"\x27$(mktemp)\x27", "tmp=\x27$(mktemp -d)\x27 && cp src/a.ts \"$tmp/\"", 'true || tmp=$(mktemp -d) && cp src/a.ts "$tmp/"', '! tmp=$(mktemp -d) && cp src/a.ts "$tmp/"', 'true | tmp=$(mktemp -d) && cp src/a.ts "$tmp/"', 'tmp=$(mktemp -d); cp src/a.ts "$tmp/"', 'false && tmp=$(mktemp -d) || cp src/a.ts "$tmp/"', 'tmp=$(mktemp -d) && tmp=OUTSIDE && cp src/a.ts "$tmp/"', 'tmp=$(mktemp -d) && printf -v tmp %s OUTSIDE && cp src/a.ts "$tmp/"', 'tmp=$(mktemp -u) && cp src/a.ts "$tmp/"', 'echo x > "\\$(mktemp)"', "echo x > '$(mktemp)'", 'tmp=$(mktemp -d -p OUTSIDE) && cp src/a.ts "$tmp/"'])("does not refuse ordinary work for an unproven temporary destination: %s", source => expect(fixture().check(source, "ranger").allow).toBe(true));
it("passes a local Smith command with a temporary array assignment", () => expect(fixture().check('tmp=$(mktemp -d) && tmp[0]=OUTSIDE && cp src/a.ts "$tmp/"').allow).toBe(true));
it("keeps explicit scratch denies as data, not a hold on ordinary work", () => {
  expect(fixture().check('tmp=$(mktemp -d) && cp src/a.ts "$tmp/"', "keeper").allow).toBe(true);
  const f = fixture();
  expect(f.check('echo x > "$(mktemp)"', "ranger", [join(f.root, "scratch", "*.secret")]).allow).toBe(true);
});
