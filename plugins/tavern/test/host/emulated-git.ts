import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
export const PENDING_LIVE_VERIFICATION: readonly string[] = [];

export function emulatedGit(root: string, refuseCached = false): string {
  const bin = join(root, "bin"); mkdirSync(bin);
  const file = join(bin, "git");
  writeFileSync(file, `#!/usr/bin/env python3
import os, re, subprocess, sys
args = sys.argv[1:]
cwd = args[args.index('-C') + 1] if '-C' in args else os.getcwd()
member = any('/' + name in cwd for name in ('maker', 'checker', 'member'))
a = args[:]
if '-C' in a:
    i = a.index('-C'); del a[i:i+2]
settings = []
while a[:1] == ['-c']:
    settings.append(a[1]); del a[:2]
if ${refuseCached ? "True" : "False"} and 'ls-files' in a and '--cached' in a:
    print('worldtree emulation: ls-files --cached refused', file=sys.stderr); sys.exit(91)
if member:
    oid = lambda s: bool(re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}|HEAD', s))
    verified = a in [['rev-parse', '--verify', 'HEAD'], ['rev-parse', '--verify', 'HEAD^{tree}'], ['rev-parse', '--show-toplevel'], ['rev-parse', '--git-dir'], ['rev-parse', '--git-dir', '--git-common-dir'], ['rev-parse', '--is-bare-repository'], ['symbolic-ref', '--short', '-q', 'HEAD'], ['symbolic-ref', '-q', 'HEAD'], ['remote', '-v'], ['for-each-ref'], ['ls-files', '--unmerged'], ['ls-files', '--unmerged', '-z'], ['cat-file', '-t', 'HEAD']]
    if a[:1] == ['config']:
        verified = a in [['config', '--get', 'extensions.objectformat'], ['config', '--get', 'user.email'], ['config', '--type=bool', '--get', 'core.filemode'], ['config', '--type=bool', '--get', 'core.sparseCheckout']]
    if a[:1] == ['cat-file']:
        verified = a in [['cat-file', '-t', 'HEAD'], ['cat-file', '--batch-check']] or len(a) == 3 and a[1] in ['tree', 'commit', 'blob'] and oid(a[2])
    if a[:2] == ['rev-parse', '--verify'] and len(a) == 3 and a[2].endswith('^{tree}'):
        verified = oid(a[2][:-7])
    if a[:1] == ['status']:
        verified = a in [['status', '--porcelain'], ['status', '--porcelain', '-z'], ['status', '--porcelain', '--untracked-files=no'], ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames']] or a[:5] == ['status', '--porcelain', '--ignored', '-z', '--']
    if a[:1] == ['diff']:
        verified = a in [['diff', '--cached', '--quiet'], ['diff', '--cached', '--name-only', '-z']]
        if a[:4] == ['diff', '--name-status', '--no-renames', '-z']:
            verified = len(a) in [5, 6] and all(oid(s) for s in a[4:])
        if a[:4] == ['diff', '--name-only', '-z', '--no-renames']:
            verified = len(a) in [4, 5, 6] and all(oid(s) for s in a[4:])
        if '--raw' in a:
            verified = all(s in ['diff', '--raw', '--cached', '--no-renames', '--no-ext-diff', '-z'] or oid(s) for s in a)
    if a[:2] == ['ls-tree', '-z']:
        verified = len(a) == 3 and oid(a[2])
    if a[:4] == ['ls-tree', '-r', '-z', '--full-tree']:
        verified = len(a) >= 7 and oid(a[4]) and a[5] == '--'
    if a[:4] == ['ls-files', '--stage', '-z', '--']:
        verified = len(a) >= 5
    if a == ['add', '-A'] or a[:3] == ['add', '-A', '--']: verified = True
    if a[:1] == ['commit']:
        verified = len(a) >= 3 and a[-2] == '-m' and all(s in ['commit', '--no-gpg-sign', '--no-verify', '--no-post-rewrite', '-q'] for s in a[:-2])
    verified = verified and all(s in ['gc.auto=0', 'maintenance.auto=false', 'user.name=Tavern', 'user.email=tavern@localhost'] for s in settings)
    blocked = any(s in ['--no-abbrev', '--no-textconv', '--full-index', '--sparse'] or s.startswith('--abbrev=') for s in a)
    if not verified or blocked or (os.environ.get('GIT_INDEX_FILE') and 'add' not in a):
        print('worldtree emulation: unverified command refused: ' + ' '.join(args), file=sys.stderr); sys.exit(91)
    for setting in settings:
        if not setting.startswith(('user.', 'author.', 'committer.', 'color.')):
            print('wt git: warning: ignoring -c ' + setting.split('=')[0] + '=… — worldtree honors only identity and color config', file=sys.stderr)
    if a[:1] == ['diff'] and '--raw' in a:
        at = args.index('diff') + 1
        result = subprocess.run([${JSON.stringify(realGit)}] + args[:at] + ['--abbrev=14'] + args[at:], stdout=subprocess.PIPE)
        sys.stdout.buffer.write(result.stdout); sys.exit(result.returncode)
os.execv(${JSON.stringify(realGit)}, [${JSON.stringify(realGit)}] + args)
`);
  chmodSync(file, 0o755); return bin;
}
