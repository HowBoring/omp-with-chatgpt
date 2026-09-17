import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir } from "./helpers.js";
import { enableTask, taskFile } from "../src/extension/task-state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src/cli/index.ts");

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", cliEntry, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

/** Seed today's cache so update-check reports an available update offline. */
function seedUpdateCache(stateDir: string): void {
  const today = new Date().toLocaleDateString("en-CA");
  fs.writeFileSync(
    path.join(stateDir, "update-check.json"),
    JSON.stringify({ date: today, updateAvailable: true, remoteCommit: "0".repeat(40) })
  );
}

describe("update-check defers while a C2C task is active (issue #14)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("reports deferred=false when an update is available and no task is active", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    seedUpdateCache(stateDir);
    const result = runCli(["update-check", "--json"], { C2C_STATE_DIR: stateDir });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      updateAvailable: boolean;
      deferred?: boolean;
      reloadRequired?: boolean;
    };
    expect(payload.updateAvailable).toBe(true);
    expect(payload.deferred).toBe(false);
    expect(payload.reloadRequired).toBe(true);
  });

  it("reports deferred=true when any workspace has an active task", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    seedUpdateCache(stateDir);
    enableTask("ws-deferral-test", "goal", "owner-session");
    expect(fs.existsSync(taskFile("ws-deferral-test"))).toBe(true);

    const result = runCli(["update-check", "--json"], { C2C_STATE_DIR: stateDir });
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { updateAvailable: boolean; deferred?: boolean };
    expect(payload.updateAvailable).toBe(true);
    expect(payload.deferred).toBe(true);
  });

  it("does not defer for a finished task", () => {
    const stateDir = isolateStateDir();
    dirs.push(stateDir);
    seedUpdateCache(stateDir);
    const task = enableTask("ws-deferral-done", "goal", "owner-session");
    fs.writeFileSync(
      taskFile("ws-deferral-done"),
      JSON.stringify({ ...task, state: "done", outcome: "done" }),
      { mode: 0o600 }
    );

    const result = runCli(["update-check", "--json"], { C2C_STATE_DIR: stateDir });
    const payload = JSON.parse(result.stdout) as { deferred?: boolean };
    expect(payload.deferred).toBe(false);
  });
});
