import { afterEach, describe, expect, it } from "vitest";
import {
  enableTask,
  finishTask,
  mirrorOf,
  readTask,
  reconcileMirror,
  takeoverTask,
  TaskError,
  updateCheckpoint,
  type CheckpointMirror,
} from "../src/extension/task-state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

function wid(workspaceDir: string): string {
  return new Workspace(workspaceDir).id;
}

describe("c2c task checkpoints", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): { id: string } {
    isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-checkpoint");
    dirs.push(workspaceDir, process.env.C2C_STATE_DIR as string);
    return { id: wid(workspaceDir) };
  }

  it("enable starts at revision 1 and every mutation bumps it", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    expect(task.revision).toBe(1);
    const updated = updateCheckpoint(id, "owner", task.revision, { protocolState: "INIT" });
    expect(updated.revision).toBe(2);
    const taken = takeoverTask(id, "successor");
    expect(taken.revision).toBe(3);
    const closed = finishTask(id, "successor", "done");
    expect(closed.revision).toBe(4);
  });

  it("updateCheckpoint rejects a stale revision without touching state", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    updateCheckpoint(id, "owner", task.revision, { protocolState: "INIT", waitingFor: "GPT_PLAN" });
    // A writer holding the pre-update view is fenced out.
    expect(() =>
      updateCheckpoint(id, "owner", task.revision, { protocolState: "EXECUTING" })
    ).toThrowError(/revision 2, not 1/);
    const current = readTask(id);
    expect(current?.checkpoint?.protocolState).toBe("INIT");
    expect(current?.revision).toBe(2);
  });

  it("updateCheckpoint enforces ownership and active state", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    expect(() =>
      updateCheckpoint(id, "intruder", task.revision, { protocolState: "INIT" })
    ).toThrowError(TaskError);
    finishTask(id, "owner", "done");
    expect(() =>
      updateCheckpoint(id, "owner", 2, { protocolState: "DONE" })
    ).toThrowError(/already done/);
  });

  it("updateCheckpoint validates protocol vocabulary", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    expect(() =>
      updateCheckpoint(id, "owner", task.revision, {
        protocolState: "NOPE" as never,
      })
    ).toThrowError(/protocolState must be one of/);
    expect(() =>
      updateCheckpoint(id, "owner", task.revision, { waitingFor: "GODOT" as never })
    ).toThrowError(/waitingFor must be one of/);
    expect(() =>
      updateCheckpoint(id, "owner", task.revision, { iteration: -1 })
    ).toThrowError(/non-negative integer/);
    expect(readTask(id)?.revision).toBe(task.revision);
  });

  it("checkpoint and binding persist identity, iteration, and chat/project binding", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    updateCheckpoint(id, "owner", task.revision, {
      protocolState: "EXECUTED_SENT",
      waitingFor: "GPT_REVIEW",
      iteration: 3,
      binding: {
        mode: "project",
        chatUrl: "https://chatgpt.com/c/abc",
        projectUrl: "https://chatgpt.com/g/g-p-xyz/project",
        connectorName: "OMP with ChatGPT — ws",
      },
    });
    const restored = readTask(id);
    expect(restored?.taskId).toBe(task.taskId);
    expect(restored?.iteration).toBe(3);
    expect(restored?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(restored?.checkpoint?.waitingFor).toBe("GPT_REVIEW");
    expect(restored?.binding?.projectUrl).toBe("https://chatgpt.com/g/g-p-xyz/project");
  });

  it("reconcileMirror: workspace record wins and a stale mirror is flagged", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    const mirrorV1 = mirrorOf(task);
    const updated = updateCheckpoint(id, "owner", task.revision, { protocolState: "INIT" });

    const stale = reconcileMirror(updated, mirrorV1);
    expect(stale.authoritative?.revision).toBe(2);
    expect(stale.mirrorStale).toBe(true);

    const fresh = reconcileMirror(updated, mirrorOf(updated));
    expect(fresh.mirrorStale).toBe(false);

    // A mirror for a different task id is also stale relative to the file.
    const other: CheckpointMirror = { ...mirrorOf(updated), taskId: "c2c_ffff" };
    expect(reconcileMirror(updated, other).mirrorStale).toBe(true);
  });

  it("reconcileMirror: mirror without a workspace file is orphaned, never authoritative", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    const mirror = mirrorOf(task);
    const orphaned = reconcileMirror(null, mirror);
    expect(orphaned.authoritative).toBeNull();
    expect(orphaned.mirrorOrphaned).toBe(true);
    expect(reconcileMirror(null, null)).toEqual({
      authoritative: null,
      mirror: null,
      mirrorStale: false,
      mirrorOrphaned: false,
    });
  });
});
