import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";

export function isolateTestEnvironment() {
  const base = process.platform === "darwin" ? execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim() : tmpdir();
  const root = realpathSync(mkdtempSync(join(base, "tavern-vitest-")));
  const directories = {
    HOME: "home", PI_CODING_AGENT_DIR: "home/pi-agent", USERPROFILE: "home",
    XDG_CONFIG_HOME: "config", XDG_CACHE_HOME: "cache", XDG_DATA_HOME: "data", XDG_STATE_HOME: "state", XDG_RUNTIME_DIR: "run",
    TMPDIR: "tmp", TMP: "tmp", TEMP: "tmp", TAVERN_TEST_FIXTURES: "fixtures",
  };
  process.env.TAVERN_TEST_ROOT = root;
  process.env.TAVERN_TEST_REAL_HOME = userInfo().homedir;
  process.env.TAVERN_TEST_PI_MODULES = join(userInfo().homedir, ".pi/pkg/pi-1.5.0/node_modules");
  for (const [key, directory] of Object.entries(directories)) {
    const path = join(root, directory); mkdirSync(path, { recursive: true }); process.env[key] = path;
  }
  process.env.XDG_CONFIG_DIRS = process.env.XDG_CONFIG_HOME;
  process.env.XDG_DATA_DIRS = process.env.XDG_DATA_HOME;
  process.env.npm_config_cache = join(root, "cache/npm");
  process.env.npm_config_userconfig = join(root, "home/.npmrc");
  process.env.GIT_CONFIG_GLOBAL = join(root, "home/.gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  return root;
}
