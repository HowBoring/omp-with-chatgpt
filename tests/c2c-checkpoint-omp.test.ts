import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import { readTask, updateCheckpoint } from "../src/extension/task-state.js";
import { CHECKPOINT_MIRROR_TYPE } from "../src/extension/index.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NL = String.fromCharCode(10);

/**
 * Real-OMP end-to-end coverage for checkpoint persistence and restore
 * (issue #5).
 *
 * OMP persists a session lazily: it stays memory-only until it contains an
 * assistant message (see omp session docs), so run 1 drives the C2C command
 * handlers from `agent_end` — after a real model turn has crossed the
 * persistence gate — which is also when the transcript mirror is appended.
 * Run 2 then resumes with `--continue` and a slash-only print command (no
 * model needed) and dumps the transcript mirror, proving the same session
 * recovers task identity, iteration, checkpoint, and binding passively.
 *
 * Probe source is plain JavaScript in a template string (runs under OMP,
 * not tsc); newlines use String.fromCharCode(10) so no backslash sequences
 * cross the template boundary.
 */
function writeHarness(opts: {
  dir: string;
  name: string;
  sid: string;
  script: Array<[string, string]>;
  hook: "agent_end" | "session_start";
  dumpMirror: boolean;
}): string {
  const extPath = path.join(projectRoot, "src/extension/index.ts").replace(/\\/g, "/");
  const harness = path.join(opts.dir, `${opts.name}.ts`);
  const mirrorLines = opts.dumpMirror
    ? [
        '    for (const entry of ctx.sessionManager.getBranch()) {',
        '      if (entry && entry.type === "custom" && entry.customType === MIRROR_TYPE) {',
        '        results.push("MIRROR " + JSON.stringify(entry.data));',
        "      }",
        "    }",
      ]
    : [];
  const lines = [
    `import ext from ${JSON.stringify(extPath)};`,
    "const NL = String.fromCharCode(10);",
    `const MIRROR_TYPE = ${JSON.stringify(CHECKPOINT_MIRROR_TYPE)};`,
    "export default function probe(pi) {",
    "  const registry = {};",
    "  const register = pi.registerCommand.bind(pi);",
    "  pi.registerCommand = (name, opts) => {",
    "    registry[name] = opts.handler;",
    "    return register(name, opts);",
    "  };",
    "  ext(pi);",
    `  pi.on(${JSON.stringify(opts.hook)}, async (_event, ctx) => {`,
    "    const results = [];",
    `    const sid = ${JSON.stringify(opts.sid)};`,
    "    const fakeCtx = {",
    '      ui: { notify: (message) => { results.push("NOTIFY " + String(message).split(NL).join(" | ")); } },',
    "      cwd: ctx.cwd,",
    "      sessionManager: { getSessionId: () => sid, getBranch: () => ctx.sessionManager.getBranch() },",
    "    };",
    `    const script = ${JSON.stringify(opts.script)};`,
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
    ...mirrorLines,
    '    results.push("REAL_SID " + ctx.sessionManager.getSessionId());',
    '    for (const line of results) console.log("PROBE-RESULT " + line);',
    "  });",
    "}",
    "",
  ];
  fs.writeFileSync(harness, lines.join(NL));
  return harness;
}

function runProbe(opts: {
  probePath: string;
  workspaceDir: string;
  stateDir: string;
  sessionDir: string;
  prompt: string;
  continueSession: boolean;
}): { results: string[]; status: number | null; stderr: string } {
  const args = [
    "-e",
    opts.probePath,
    "-p",
    opts.prompt,
    "--session-dir",
    opts.sessionDir,
    "--cwd",
    opts.workspaceDir,
  ];
  if (opts.continueSession) args.push("--continue");
  const result = spawnSync("omp", args, {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, C2C_STATE_DIR: opts.stateDir },
    timeout: 120_000,
  });
  const results = `${result.stdout ?? ""}`
    .split(NL)
    .filter((line) => line.startsWith("PROBE-RESULT "))
    .map((line) => line.slice("PROBE-RESULT ".length));
  return { results, status: result.status, stderr: result.stderr ?? "" };
}

describe("c2c checkpoint restore under a real OMP process", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("same-session resume preserves task identity, iteration, checkpoint, and binding", () => {
    const stateDir = isolateStateDir();
    const probeDir = makeTmpDir("c2c-restore");
    const workspaceDir = makeTmpDir("c2c-restore-ws");
    const sessionDir = makeTmpDir("c2c-restore-sessions");
    dirs.push(stateDir, probeDir, workspaceDir, sessionDir);
    const wid = new Workspace(workspaceDir).id;

    // Run 1: a real model turn crosses the persistence gate; on agent_end
    // the probe enables a task and advances its checkpoint, which also
    // appends the transcript mirror.
    const probe1 = writeHarness({
      dir: probeDir,
      name: "probe-run1",
      sid: "restore-owner",
      script: [
        ["c2c-enable", "restore me"],
        [
          "c2c-checkpoint",
          "state=EXECUTED_SENT waiting=GPT_REVIEW iter=3 mode=project project=https://chatgpt.com/g/g-p-xyz/project chat=https://chatgpt.com/c/abc connector=OMP-Test",
        ],
      ],
      hook: "agent_end",
      dumpMirror: false,
    });
    const run1 = runProbe({
      probePath: probe1,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "Reply with exactly: OK",
      continueSession: false,
    });
    expect(run1.status).toBe(0);
    expect(run1.results).toContain("OK c2c-enable");
    expect(run1.results).toContain("OK c2c-checkpoint");
    const sid1 = (run1.results.find((r) => r.startsWith("REAL_SID ")) ?? "").slice(9);
    expect(sid1).not.toBe("");

    const task = readTask(wid);
    expect(task?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(task?.iteration).toBe(3);
    expect(task?.binding?.projectUrl).toBe("https://chatgpt.com/g/g-p-xyz/project");

    // Run 2: resume the same session with a slash-only print command (no
    // model needed); the probe dumps the transcript mirror.
    const probe2 = writeHarness({
      dir: probeDir,
      name: "probe-run2",
      sid: "restore-owner",
      script: [],
      hook: "session_start",
      dumpMirror: true,
    });
    const run2 = runProbe({
      probePath: probe2,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "/c2c-status",
      continueSession: true,
    });
    expect(run2.status).toBe(0);
    const sid2 = (run2.results.find((r) => r.startsWith("REAL_SID ")) ?? "").slice(9);
    expect(sid2).toBe(sid1);

    const mirrorLines = run2.results.filter((r) => r.startsWith("MIRROR "));
    expect(mirrorLines.length).toBeGreaterThan(0);
    const mirror = JSON.parse(mirrorLines[mirrorLines.length - 1]!.slice(7)) as {
      taskId: string;
      revision: number;
      iteration: number;
      checkpoint?: { protocolState: string; waitingFor: string };
      binding?: { mode?: string; chatUrl?: string; projectUrl?: string; connectorName?: string };
    };
    expect(mirror.taskId).toBe(task?.taskId);
    expect(mirror.revision).toBe(task?.revision);
    expect(mirror.iteration).toBe(3);
    expect(mirror.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(mirror.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(mirror.binding?.mode).toBe("project");
    expect(mirror.binding?.chatUrl).toBe("https://chatgpt.com/c/abc");
    expect(mirror.binding?.connectorName).toBe("OMP-Test");

    // Restore is passive: the workspace record is unchanged by run 2 and
    // nothing sent external messages (the extension has no send path; the
    // registration-surface unit test asserts no tool/prompt hooks).
    const after = readTask(wid);
    expect(after?.revision).toBe(task?.revision);
    expect(after?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
  });

  it("a stale transcript mirror never overwrites newer workspace state", () => {
    const stateDir = isolateStateDir();
    const probeDir = makeTmpDir("c2c-stale");
    const workspaceDir = makeTmpDir("c2c-stale-ws");
    const sessionDir = makeTmpDir("c2c-stale-sessions");
    dirs.push(stateDir, probeDir, workspaceDir, sessionDir);
    const wid = new Workspace(workspaceDir).id;

    // Run 1: enable only (mirror rev=1, no checkpoint).
    const probe1 = writeHarness({
      dir: probeDir,
      name: "probe-stale1",
      sid: "stale-owner",
      script: [["c2c-enable", "goal"]],
      hook: "agent_end",
      dumpMirror: false,
    });
    const run1 = runProbe({
      probePath: probe1,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "Reply with exactly: OK",
      continueSession: false,
    });
    expect(run1.results).toContain("OK c2c-enable");
    const revAfterEnable = readTask(wid)?.revision ?? 0;

    // Advance the workspace record OUTSIDE the session (rev now ahead of
    // the transcript mirror), as another live session would.
    updateCheckpoint(wid, "stale-owner", revAfterEnable, {
      protocolState: "PLAN_RECEIVED",
      iteration: 1,
    });
    expect(readTask(wid)?.revision).toBe(revAfterEnable + 1);

    // Run 2: resume; the passive restore must not roll the workspace
    // record back to the mirrored revision.
    const probe2 = writeHarness({
      dir: probeDir,
      name: "probe-stale2",
      sid: "stale-owner",
      script: [],
      hook: "session_start",
      dumpMirror: true,
    });
    const run2 = runProbe({
      probePath: probe2,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "/c2c-status",
      continueSession: true,
    });
    expect(run2.status).toBe(0);
    expect(run2.results.some((r) => r.startsWith("MIRROR "))).toBe(true);
    const final = readTask(wid);
    expect(final?.revision).toBe(revAfterEnable + 1);
    expect(final?.checkpoint?.protocolState).toBe("PLAN_RECEIVED");
    expect(final?.iteration).toBe(1);
  });
});
