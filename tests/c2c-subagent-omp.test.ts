import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { readTask } from "../src/extension/task-state.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NL = String.fromCharCode(10);

/**
 * Real-OMP end-to-end coverage for main-session vs subagent ownership
 * (issue #8). The probe runs the extension's command handlers in BOTH the
 * main session and a spawned subagent session (session_start fires in
 * each; OMP re-binds parent extension factories for subagents).
 *
 * Verified signal (see src/extension/index.ts isSubagentSession): a main
 * session file basename contains the session id; a subagent file is
 * `<main-stem>/<AgentName>.jsonl` and its header carries parentSession.
 *
 * Sequence: the main session enables and immediately finishes a task, so
 * the subagent's later enable attempt is stopped only by the subagent
 * guard — not by TASK_ACTIVE.
 */
function writeHarness(dir: string): string {
  const extPath = path.join(projectRoot, "src/extension/index.ts").replace(/\\/g, "/");
  const harness = path.join(dir, "probe-subagent.ts");
  const lines = [
    `import ext from ${JSON.stringify(extPath)};`,
    "const NL = String.fromCharCode(10);",
    "export default function probe(pi) {",
    "  const registry = {};",
    "  const register = pi.registerCommand.bind(pi);",
    "  pi.registerCommand = (name, opts) => { registry[name] = opts.handler; return register(name, opts); };",
    "  ext(pi);",
    '  pi.on("session_start", async (_event, ctx) => {',
    "    const sid = ctx.sessionManager.getSessionId();",
    "    const file = ctx.sessionManager.getSessionFile ? String(ctx.sessionManager.getSessionFile()) : 'null';",
    '    const isSub = !file.includes(sid) ? "subagent" : "main";',
    "    const results = [];",
    "    const fakeCtx = {",
    '      ui: { notify: (m) => { results.push("NOTIFY " + String(m).split(NL).join(" | ")); } },',
    "      cwd: ctx.cwd,",
    "      sessionManager: ctx.sessionManager,",
    "    };",
    '    results.push("ROLE " + isSub + " SID " + sid + " FILE " + file);',
    "    if (isSub === 'main') {",
    "      try { await registry['c2c-enable']('main task', fakeCtx); results.push('ENABLE_OK'); }",
    "      catch (e) { results.push('ENABLE_ERR ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "      try { await registry['c2c-finish']('done probing', fakeCtx); results.push('FINISH_OK'); }",
    "      catch (e) { results.push('FINISH_ERR ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "    } else {",
    "      try { await registry['c2c-status']('', fakeCtx); results.push('STATUS_OK'); }",
    "      catch (e) { results.push('STATUS_ERR ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "      try { await registry['c2c-enable']('subagent task', fakeCtx); results.push('ENABLE_OK'); }",
    "      catch (e) { results.push('ENABLE_ERR ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "      try { await registry['c2c-takeover']('', fakeCtx); results.push('TAKEOVER_OK'); }",
    "      catch (e) { results.push('TAKEOVER_ERR ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "    }",
    '    for (const line of results) console.log("PROBE-RESULT " + line);',
    "  });",
    "}",
    "",
  ];
  fs.writeFileSync(harness, lines.join(NL));
  return harness;
}

describe("main-session vs subagent ownership under a real OMP process", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("subagent cannot enable or take over a top-level task; main session can", () => {
    const stateDir = isolateStateDir();
    const probeDir = makeTmpDir("c2c-subagent");
    const workspaceDir = makeTmpDir("c2c-subagent-ws");
    const sessionDir = makeTmpDir("c2c-subagent-sessions");
    dirs.push(stateDir, probeDir, workspaceDir, sessionDir);
    const wid = new Workspace(workspaceDir).id;

    const probe = writeHarness(probeDir);
    const result = spawnSync(
      "omp",
      [
        "-e",
        probe,
        "-p",
        "Use the task tool to spawn exactly one subagent with the prompt 'reply with exactly SUBAGENT-OK'. After it finishes, reply with exactly: DONE",
        "--session-dir",
        sessionDir,
        "--cwd",
        workspaceDir,
      ],
      {
        cwd: projectRoot,
        encoding: "utf8",
        env: { ...process.env, C2C_STATE_DIR: stateDir },
        timeout: 300_000,
      }
    );
    const results = (result.stdout ?? "")
      .split(NL)
      .filter((line) => line.startsWith("PROBE-RESULT "))
      .map((line) => line.slice("PROBE-RESULT ".length));

    // Both a main-session and a subagent-session probe run happened.
    const mainRole = results.find((r) => r.startsWith("ROLE main "));
    const subRole = results.find((r) => r.startsWith("ROLE subagent "));
    expect(mainRole, results.join(" | ")).toBeDefined();
    expect(subRole, results.join(" | ")).toBeDefined();

    // The main session enabled and closed the task; the workspace record
    // is attributed to the main session id.
    expect(results).toContain("ENABLE_OK");
    expect(results).toContain("FINISH_OK");
    const mainSid = (mainRole ?? "").match(/SID (\S+)/)?.[1] ?? "";
    expect(readTask(wid)?.ownerSessionId).toBe(mainSid);
    expect(readTask(wid)?.outcome).toBe("done");

    // The subagent could inspect (read-only) but could not enable a second
    // top-level task nor take over.
    expect(results).toContain("STATUS_OK");
    const subEnable = results.find((r) => r.startsWith("ENABLE_ERR "));
    expect(subEnable).toBeDefined();
    expect(subEnable).toContain("subagent");
    const subTakeover = results.find((r) => r.startsWith("TAKEOVER_ERR "));
    expect(subTakeover).toBeDefined();
    expect(subTakeover).toContain("subagent");

    // No second task was created: the workspace still holds exactly the
    // main session's finished task.
    expect(readTask(wid)?.goal).toBe("main task");
  }, 300_000);
});
