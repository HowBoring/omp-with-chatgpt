import { afterEach, describe, expect, it } from "vitest";
import { GATED_TOOLS, stopGateVerdict, toolGateVerdict } from "../src/extension/gates.js";
import { enableTask, updateCheckpoint, type C2CTask } from "../src/extension/task-state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

describe("protocol gates", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function taskIn(state: { waitingFor?: "GPT_PLAN" | "GPT_REVIEW"; closed?: boolean }): C2CTask {
    const stateDir = isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-gates");
    dirs.push(stateDir, workspaceDir);
    const id = new Workspace(workspaceDir).id;
    const task = enableTask(id, "goal", "owner");
    if (state.waitingFor) {
      return updateCheckpoint(id, "owner", task.revision, {
        protocolState: state.waitingFor === "GPT_PLAN" ? "INIT" : "EXECUTED_SENT",
        waitingFor: state.waitingFor,
      });
    }
    return task;
  }

  it("blocks modifying tools for the owner while awaiting PLAN", () => {
    const task = taskIn({ waitingFor: "GPT_PLAN" });
    for (const tool of GATED_TOOLS) {
      const verdict = toolGateVerdict(task, "owner", tool);
      expect(verdict.blocked, tool).toBe(true);
      if (verdict.blocked) expect(verdict.reason).toContain("PLAN");
    }
  });

  it("blocks modifying tools for the owner while awaiting REVIEW", () => {
    const task = taskIn({ waitingFor: "GPT_REVIEW" });
    const verdict = toolGateVerdict(task, "owner", "write");
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) expect(verdict.reason).toContain("REVIEW");
  });

  it("never gates read-only tools, non-owner sessions, or non-gated states", () => {
    const gated = taskIn({ waitingFor: "GPT_PLAN" });
    expect(toolGateVerdict(gated, "owner", "read").blocked).toBe(false);
    expect(toolGateVerdict(gated, "owner", "grep").blocked).toBe(false);
    expect(toolGateVerdict(gated, "intruder", "write").blocked).toBe(false);

    const noCheckpoint = taskIn({});
    expect(toolGateVerdict(noCheckpoint, "owner", "write").blocked).toBe(false);

    expect(toolGateVerdict(null, "owner", "write").blocked).toBe(false);
  });

  it("stop gate blocks completion only while the owner awaits REVIEW", () => {
    const review = taskIn({ waitingFor: "GPT_REVIEW" });
    expect(stopGateVerdict(review, "owner").blocked).toBe(true);
    expect(stopGateVerdict(review, "intruder").blocked).toBe(false);

    const plan = taskIn({ waitingFor: "GPT_PLAN" });
    expect(stopGateVerdict(plan, "owner").blocked).toBe(false);

    expect(stopGateVerdict(null, "owner").blocked).toBe(false);
  });
});
