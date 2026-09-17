import ompWithChatGPT from "../src/extension/index.js";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildStatusMessage, formatStateSummary } from "../src/extension/index.js";
import { writeSession } from "../src/session/state.js";
import { PRODUCT_NAME, VERSION } from "../src/version.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("formatStateSummary", () => {
  it("reports no state when the session file is missing", () => {
    expect(formatStateSummary(null, false)).toMatch(/^no state/);
  });

  it("reports empty when a session exists but has no task", () => {
    expect(
      formatStateSummary({ savedAt: "2026-01-01T00:00:00.000Z" }, true)
    ).toMatch(/^empty/);
  });

  it("reports the active task identity when a checkpoint exists", () => {
    const summary = formatStateSummary(
      {
        taskId: "c2c_ab12",
        iteration: 7,
        checkpoint: {
          taskId: "c2c_ab12",
          iteration: 7,
          protocolState: "EXECUTED_SENT",
          waitingFor: "GPT_REVIEW",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        savedAt: "2026-01-01T00:00:00.000Z",
      },
      true
    );
    expect(summary).toContain("c2c_ab12");
    expect(summary).toContain("EXECUTED_SENT");
    expect(summary).toContain("GPT_REVIEW");
  });
});

describe("buildStatusMessage", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  it("includes workspace, product identity, state dir, and missing-state summary", () => {
    const stateDir = isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-status-ws");
    dirs.push(stateDir, workspaceDir);
    const workspace = new Workspace(workspaceDir);

    const message = buildStatusMessage(workspaceDir);

    expect(message).toContain(`${PRODUCT_NAME} ${VERSION}`);
    expect(message).toContain(`workspace=${workspace.root}`);
    expect(message).toContain(`stateDir=${path.resolve(stateDir)}`);
    expect(message).toContain("no state");
  });

  it("distinguishes an active task from an empty session", () => {
    const stateDir = isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-status-active");
    dirs.push(stateDir, workspaceDir);
    const workspace = new Workspace(workspaceDir);
    writeSession(workspace.id, {
      taskId: "c2c_ab12",
      iteration: 3,
      checkpoint: {
        taskId: "c2c_ab12",
        iteration: 3,
        protocolState: "PLAN_RECEIVED",
        waitingFor: "none",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      savedAt: "2026-01-01T00:00:00.000Z",
    });

    const message = buildStatusMessage(workspaceDir);

    expect(message).toContain("c2c_ab12");
    expect(message).toContain("PLAN_RECEIVED");
    expect(fs.existsSync(path.join(stateDir, "sessions", `${workspace.id}.json`))).toBe(true);
  });
});

describe("extension registration surface", () => {
  it("registers the c2c commands and only restore + gate hooks", () => {
    const calls: string[] = [];
    const pi = {
      setLabel: (_label: string) => {
        calls.push("setLabel");
      },
      registerCommand: (name: string, _opts: unknown) => {
        calls.push(`registerCommand:${name}`);
      },
      on: (event: string, ..._args: unknown[]) => {
        calls.push(`on:${event}`);
      },
      registerTool: (..._args: unknown[]) => {
        calls.push("registerTool");
      },
    };
    ompWithChatGPT(pi);
    expect(calls).toContain("registerCommand:c2c-status");
    expect(calls).toContain("registerCommand:c2c-enable");
    expect(calls).toContain("registerCommand:c2c-cancel");
    expect(calls).toContain("registerCommand:c2c-finish");
    expect(calls).toContain("registerCommand:c2c-takeover");
    expect(calls).toContain("registerCommand:c2c-checkpoint");
    // Hooks are limited to passive restore (session_start) and the
    // protocol gates (tool_call, session_stop) — never prompt/input/turn
    // interception or tool registration.
    expect(calls.filter((c) => c.startsWith("on:")).sort()).toEqual([
      "on:session_start",
      "on:session_stop",
      "on:tool_call",
    ]);
    expect(calls).not.toContain("registerTool");
  });
});
