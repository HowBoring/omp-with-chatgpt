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
 * Real-OMP end-to-end coverage for the C2C task commands (issue #4,
 * criterion 6). Each run loads a small probe extension that imports the
 * shipped `src/extension/index.ts`, captures its command handlers, and
 * drives them from `session_start` with a caller-chosen session id. Fixed
 * ids per run are the only way to model owner vs non-owner sessions because
 * OMP assigns a fresh id per process. The trailing `-p "/c2c-status"` prompt
 * dispatches a slash command only and needs no model access.
 *
 * Note: the probe source below is plain JavaScript inside a template string
 * (it runs under OMP, not tsc), and uses String.fromCharCode(10) instead of
 * newline escapes so no backslash sequences cross the template boundary.
 */
function writeHarness(dir: string, sid: string | null, script: Array<[string, string]>): string {
  const extPath = path.join(projectRoot, "src/extension/index.ts").replace(/\\/g, "/");
  const harness = path.join(dir, `probe-ext-${Math.random().toString(36).slice(2)}.ts`);
  const sidLine =
    sid === null
      ? "const sid = ctx.sessionManager.getSessionId();"
      : `const sid = ${JSON.stringify(sid)};`;
  const lines = [
    `import ext from ${JSON.stringify(extPath)};`,
    "const NL = String.fromCharCode(10);",
    "export default function probe(pi) {",
    "  const registry = {};",
    "  const register = pi.registerCommand.bind(pi);",
    "  pi.registerCommand = (name, opts) => {",
    "    registry[name] = opts.handler;",
    "    return register(name, opts);",
    "  };",
    "  ext(pi);",
    '  pi.on("session_start", async (_event, ctx) => {',
    "    const results = [];",
    '    results.push("COMMANDS " + Object.keys(registry).sort().join(","));',
    `    ${sidLine}`,
    "    const fakeCtx = {",
    '      ui: { notify: (message) => { results.push("NOTIFY " + String(message).split(NL).join(" | ")); } },',
    "      cwd: ctx.cwd,",
    "      sessionManager: { getSessionId: () => sid },",
    "    };",
    `    const script = ${JSON.stringify(script)};`,
    "    for (const pair of script) {",
    "      const cmd = pair[0];",
    "      const args = pair[1];",
    "      const handler = registry[cmd];",
    '      if (!handler) { results.push("MISSING " + cmd); continue; }',
    "      try {",
    "        await handler(args, fakeCtx);",
    '        results.push("OK " + cmd);',
    "      } catch (e) {",
    '        const code = e && e.code ? "[" + e.code + "] " : "";',
    "        const msg = e && e.message ? e.message : String(e);",
    '        results.push("ERROR " + cmd + " " + code + String(msg).split(NL).join(" | "));',
    "      }",
    "    }",
    '    results.push("SID " + sid);',
    '    results.push("REAL_SID " + ctx.sessionManager.getSessionId());',
    '    for (const line of results) console.log("PROBE-RESULT " + line);',
    "  });",
    "}",
    "",
  ];
  fs.writeFileSync(harness, lines.join(NL));
  return harness;
}

interface ProbeRun {
  results: string[];
  status: number | null;
}

function runProbe(opts: {
  probeDir: string;
  workspaceDir: string;
  stateDir: string;
  sid: string | null;
  script: Array<[string, string]>;
}): ProbeRun {
  const harness = writeHarness(opts.probeDir, opts.sid, opts.script);
  const result = spawnSync(
    "omp",
    ["-e", harness, "-p", "/c2c-status", "--no-session", "--cwd", opts.workspaceDir],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: opts.stateDir },
    }
  );
  const results = `${result.stdout ?? ""}`
    .split(NL)
    .filter((line) => line.startsWith("PROBE-RESULT "))
    .map((line) => line.slice("PROBE-RESULT ".length));
  return { results, status: result.status };
}

function errorFor(results: string[], cmd: string): string {
  return results.find((r) => r.startsWith(`ERROR ${cmd} `)) ?? "";
}

describe("c2c task commands under a real OMP process", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): { stateDir: string; workspaceDir: string; probeDir: string; wid: string } {
    const stateDir = isolateStateDir();
    const probeDir = makeTmpDir("c2c-e2e");
    const workspaceDir = makeTmpDir("c2c-e2e-ws");
    dirs.push(stateDir, probeDir, workspaceDir);
    return { stateDir, workspaceDir, probeDir, wid: new Workspace(workspaceDir).id };
  }

  it("enable, inspect, cancel, close, takeover, stale-owner rejection end to end", () => {
    const { stateDir, workspaceDir, probeDir, wid } = setup();

    // 1. Owner enables a task.
    let run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "owner-session",
      script: [["c2c-enable", "Implement dark mode"]],
    });
    expect(run.status).toBe(0);
    expect(run.results).toContain("OK c2c-enable");
    expect(readTask(wid)?.ownerSessionId).toBe("owner-session");
    expect(readTask(wid)?.state).toBe("active");
    const taskId = readTask(wid)?.taskId ?? "";
    expect(taskId).not.toBe("");

    // 2. Non-owner inspects (read-only view names the other owner) but
    //    cannot cancel or finish.
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "intruder-session",
      script: [
        ["c2c-status", ""],
        ["c2c-cancel", ""],
        ["c2c-finish", ""],
      ],
    });
    expect(run.results).toContain("OK c2c-status");
    const statusLine = run.results.find((r) => r.startsWith("NOTIFY ")) ?? "";
    expect(statusLine).toContain(taskId);
    expect(statusLine).toContain("read-only");
    expect(errorFor(run.results, "c2c-cancel")).toMatch(/NOT_OWNER/);
    expect(errorFor(run.results, "c2c-finish")).toMatch(/NOT_OWNER/);
    expect(readTask(wid)?.state).toBe("active");
    expect(readTask(wid)?.ownerSessionId).toBe("owner-session");

    // 3. Takeover by the active owner is rejected; takeover by a second
    //    session (after the owner exits — a user judgment) succeeds.
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "owner-session",
      script: [["c2c-takeover", ""]],
    });
    expect(errorFor(run.results, "c2c-takeover")).toMatch(/ALREADY_OWNER/);
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "successor-session",
      script: [["c2c-takeover", ""]],
    });
    expect(run.results).toContain("OK c2c-takeover");
    expect(readTask(wid)?.ownerSessionId).toBe("successor-session");

    // 4. Stale owner (the original session) is now read-only.
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "owner-session",
      script: [["c2c-cancel", ""]],
    });
    expect(errorFor(run.results, "c2c-cancel")).toMatch(/NOT_OWNER/);

    // 5. A second active owner is impossible: the new owner taking over
    //    from itself is refused and the task stays single-owned.
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "successor-session",
      script: [["c2c-takeover", ""]],
    });
    expect(errorFor(run.results, "c2c-takeover")).toMatch(/ALREADY_OWNER/);

    // 6. New owner cancels (distinct outcome); DONE and BLOCKED close
    //    follow-up tasks with distinct persisted outcomes.
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "successor-session",
      script: [["c2c-cancel", "user changed mind"]],
    });
    expect(run.results).toContain("OK c2c-cancel");
    expect(readTask(wid)?.outcome).toBe("cancelled");

    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "successor-session",
      script: [
        ["c2c-enable", "second goal"],
        ["c2c-finish", "shipped"],
      ],
    });
    expect(run.results).toContain("OK c2c-finish");
    expect(readTask(wid)?.outcome).toBe("done");

    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "successor-session",
      script: [
        ["c2c-enable", "third goal"],
        ["c2c-finish", "blocked waiting on API key"],
      ],
    });
    expect(run.results).toContain("OK c2c-finish");
    expect(readTask(wid)?.outcome).toBe("blocked");

    // 7. The real extension registered exactly the six commands.
    expect(run.results.find((r) => r.startsWith("COMMANDS "))).toBe(
      "COMMANDS c2c-cancel,c2c-checkpoint,c2c-enable,c2c-finish,c2c-status,c2c-takeover"
    );
  });

  it("second enable while active is rejected in the live extension", () => {
    const { stateDir, workspaceDir, probeDir, wid } = setup();
    let run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "s1",
      script: [["c2c-enable", "first"]],
    });
    expect(run.results).toContain("OK c2c-enable");
    run = runProbe({
      probeDir,
      workspaceDir,
      stateDir,
      sid: "s2",
      script: [["c2c-enable", "second"]],
    });
    expect(errorFor(run.results, "c2c-enable")).toMatch(/TASK_ACTIVE/);
    expect(readTask(wid)?.goal).toBe("first");
  });

  it("command handlers observe the real OMP session id", () => {
    const { stateDir, workspaceDir, probeDir } = setup();
    const run = runProbe({ probeDir, workspaceDir, stateDir, sid: null, script: [] });
    const sid = (run.results.find((r) => r.startsWith("SID ")) ?? "").slice(4);
    const real = (run.results.find((r) => r.startsWith("REAL_SID ")) ?? "").slice(9);
    expect(sid).not.toBe("");
    expect(sid).toBe(real);
  });
});
