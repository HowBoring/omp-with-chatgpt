import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NL = String.fromCharCode(10);

/**
 * Real-OMP end-to-end coverage for the protocol gates (issue #7).
 *
 * The probe loads the shipped extension, captures its `tool_call` and
 * `session_stop` handlers, and registers a marker tool whose execution
 * body logs TOOL-BODY-RAN. A real model turn is asked to call the tool:
 * under a gate the body must not run; with no gate it must. The
 * session_stop verdict is exercised at handler level in the same process.
 *
 * Probe source is plain JavaScript in a template string (runs under OMP,
 * not tsc); newlines use String.fromCharCode(10) so no backslash sequences
 * cross the template boundary.
 */
function writeHarness(opts: {
  dir: string;
  name: string;
  setupScript: Array<[string, string]>;
}): string {
  const extPath = path.join(projectRoot, "src/extension/index.ts").replace(/\\/g, "/");
  const harness = path.join(opts.dir, `${opts.name}.ts`);
  // session_stop is captured, not forwarded: a real block verdict re-enters
  // the session indefinitely by design (operator interrupt is the escape),
  // which a print-mode test cannot do. Platform-side stop blocking is
  // covered by the ADR-0001 live probe; here we assert the handler verdict.
  const lines = [
    `import ext from ${JSON.stringify(extPath)};`,
    "const NL = String.fromCharCode(10);",
    "export default function probe(pi) {",
    "  const handlers = {};",
    "  const onHook = pi.on.bind(pi);",
    "  pi.on = (event, handler) => { handlers[event] = handler; return event === 'session_stop' ? undefined : onHook(event, handler); };",
    "  const registry = {};",
    "  const register = pi.registerCommand.bind(pi);",
    "  pi.registerCommand = (name, opts) => { registry[name] = opts.handler; return register(name, opts); };",
    "  ext(pi);",
    "  pi.registerTool({",
    '    name: "c2c_probe_write",',
    '    label: "Probe Write",',
    '    description: "Writes a marker. Call it when asked.",',
    "    parameters: pi.zod.object({}),",
    "    async execute() {",
    '      console.log("PROBE-RESULT TOOL-BODY-RAN");',
    '      return { content: [{ type: "text", text: "wrote" }] };',
    "    },",
    "  });",
    '  pi.on("session_start", async (_event, ctx) => {',
    "    const sid = ctx.sessionManager.getSessionId();",
    "    const results = [];",
    "    const fakeCtx = {",
    '      ui: { notify: () => {} },',
    "      cwd: ctx.cwd,",
    "      sessionManager: { getSessionId: () => sid, getBranch: () => ctx.sessionManager.getBranch() },",
    "    };",
    `    const script = ${JSON.stringify(opts.setupScript)};`,
    "    for (const pair of script) {",
    "      try { await registry[pair[0]](pair[1], fakeCtx); results.push('OK ' + pair[0]); }",
    "      catch (e) { results.push('ERROR ' + pair[0] + ' ' + String(e && e.message ? e.message : e).split(NL).join(' | ')); }",
    "    }",
    "    const stopHandler = handlers['session_stop'];",
    "    if (stopHandler) {",
    "      const verdict = await stopHandler({}, fakeCtx);",
    "      results.push('STOP_VERDICT ' + JSON.stringify(verdict ?? null));",
    "    }",
    '    results.push("SID " + sid);',
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
}): { results: string[]; stdout: string; status: number | null } {
  const result = spawnSync(
    "omp",
    ["-e", opts.probePath, "-p", opts.prompt, "--session-dir", opts.sessionDir, "--cwd", opts.workspaceDir],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, C2C_STATE_DIR: opts.stateDir },
      timeout: 180_000,
    }
  );
  const stdout = result.stdout ?? "";
  const results = stdout
    .split(NL)
    .filter((line) => line.startsWith("PROBE-RESULT "))
    .map((line) => line.slice("PROBE-RESULT ".length));
  return { results, stdout, status: result.status };
}

describe("protocol gates under a real OMP process", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function setup() {
    const stateDir = isolateStateDir();
    const probeDir = makeTmpDir("c2c-gates-e2e");
    const workspaceDir = makeTmpDir("c2c-gates-e2e-ws");
    const sessionDir = makeTmpDir("c2c-gates-e2e-sessions");
    dirs.push(stateDir, probeDir, workspaceDir, sessionDir);
    return { stateDir, probeDir, workspaceDir, sessionDir };
  }

  it("blocks a modifying tool body while awaiting PLAN; allows it with no task", () => {
    const { stateDir, probeDir, workspaceDir, sessionDir } = setup();

    // Ungated baseline: no C2C task, the tool body must run.
    const openProbe = writeHarness({ dir: probeDir, name: "gate-open", setupScript: [] });
    const open = runProbe({
      probePath: openProbe,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "Call the c2c_probe_write tool exactly once, then reply DONE.",
    });
    expect(open.results.some((r) => r === "TOOL-BODY-RAN")).toBe(true);
    expect(open.results.find((r) => r.startsWith("STOP_VERDICT "))).toBe("STOP_VERDICT null");

    // Gated: task enabled and awaiting PLAN. A fresh session dir so the
    // model turn is independent; the task file lives in the shared state
    // dir and the caller is the owner by construction (probe uses the real
    // session id when enabling).
    const gatedDir = makeTmpDir("c2c-gates-e2e-sessions-2");
    dirs.push(gatedDir);
    const gatedProbe = writeHarness({
      dir: probeDir,
      name: "gate-plan",
      setupScript: [
        ["c2c-enable", " gated task"],
        ["c2c-checkpoint", "state=INIT waiting=GPT_PLAN"],
      ],
    });
    const gated = runProbe({
      probePath: gatedProbe,
      workspaceDir,
      stateDir,
      sessionDir: gatedDir,
      prompt: "Call the c2c_probe_write tool exactly once, then reply DONE.",
    });
    expect(gated.results).toContain("OK c2c-enable");
    expect(gated.results).toContain("OK c2c-checkpoint");
    expect(gated.results.some((r) => r === "TOOL-BODY-RAN")).toBe(false);
    // The stop gate does not engage while awaiting PLAN.
    expect(gated.results.find((r) => r.startsWith("STOP_VERDICT "))).toBe("STOP_VERDICT null");
  }, 300_000);

  it("stop gate blocks completion while awaiting REVIEW", () => {
    const { stateDir, probeDir, workspaceDir, sessionDir } = setup();
    const probe = writeHarness({
      dir: probeDir,
      name: "gate-review",
      setupScript: [
        ["c2c-enable", "review task"],
        ["c2c-checkpoint", "state=EXECUTED_SENT waiting=GPT_REVIEW iter=1"],
      ],
    });
    // The stop verdict is computed at session_start; no model turn needed.
    const run = runProbe({
      probePath: probe,
      workspaceDir,
      stateDir,
      sessionDir,
      prompt: "/c2c-status",
    });
    const verdictLine = run.results.find((r) => r.startsWith("STOP_VERDICT ")) ?? "";
    expect(verdictLine).toContain('"decision":"block"');
    expect(verdictLine).toContain("REVIEW");
  }, 300_000);
});
