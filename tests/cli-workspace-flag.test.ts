import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

describe("machine-wide commands accept leftover -w", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
    delete process.env.CODEX_HOME;
  });

  it("update-check --json -w does not fail with unknown option", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["update-check", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("prefs --json -w does not fail with unknown option", () => {
    dirs.push(isolateStateDir());
    const result = runCli(["prefs", "--json", "-w", "C:/Projects/aquant"], {
      C2C_STATE_DIR: process.env.C2C_STATE_DIR,
    });
    expect(result.stderr).not.toMatch(/unknown option/i);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("doctor --no-fix succeeds with no Codex config file present", () => {
    const stateDir = isolateStateDir();
    const fakeHome = path.join(stateDir, "no-codex-home");
    fs.mkdirSync(fakeHome, { recursive: true });
    dirs.push(stateDir);
    const result = runCli(["doctor", "--no-fix", "--json", "-w", projectRoot], {
      C2C_STATE_DIR: stateDir,
      // Point HOME at an empty dir so ~/.codex/config.toml cannot exist.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CODEX_HOME: path.join(fakeHome, ".codex"),
    });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      report: Record<string, { ok: boolean; detail?: string }>;
    };
    expect(payload.report.sandbox).toBeUndefined();
    expect(fs.existsSync(path.join(fakeHome, ".codex", "config.toml"))).toBe(false);
  });

  it("doctor succeeds in an env with no HOME Codex config (real homedir check)", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    const home = os.homedir();
    const codexConfig = path.join(process.env.CODEX_HOME ?? path.join(home, ".codex"), "config.toml");
    const existedBefore = fs.existsSync(codexConfig);
    const result = runCli(["doctor", "--no-fix", "--json", "-w", projectRoot], {
      C2C_STATE_DIR: stateDir,
    });
    expect(result.status).toBe(0);
    // The command must not create a Codex config file as a side effect.
    expect(fs.existsSync(codexConfig)).toBe(existedBefore);
  });
});
