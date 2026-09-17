import { afterEach, describe, expect, it } from "vitest";
import {
  cancelTask,
  enableTask,
  finishTask,
  readTask,
  takeoverTask,
  TaskError,
  taskFile,
} from "../src/extension/task-state.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";
import fs from "node:fs";

function wid(workspaceDir: string): string {
  return new Workspace(workspaceDir).id;
}

describe("c2c task lifecycle", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): { id: string } {
    isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-task");
    dirs.push(process.env.C2C_STATE_DIR as string, workspaceDir);
    return { id: wid(workspaceDir) };
  }

  it("enable creates one active task owned by the caller", () => {
    const { id } = setup();
    const task = enableTask(id, "Implement dark mode", "session-owner");
    expect(task.state).toBe("active");
    expect(task.ownerSessionId).toBe("session-owner");
    expect(task.goal).toBe("Implement dark mode");
    expect(task.taskId).toMatch(/^c2c_[0-9a-f]{4}$/);
    expect(readTask(id)).toEqual(task);
  });

  it("enable rejects an empty goal and a second active task", () => {
    const { id } = setup();
    expect(() => enableTask(id, "   ", "s1")).toThrowError(TaskError);
    enableTask(id, "first goal", "s1");
    const err = (() => {
      try {
        enableTask(id, "second goal", "s2");
      } catch (e) {
        return e as TaskError;
      }
      throw new Error("expected TASK_ACTIVE");
    })();
    expect(err.code).toBe("TASK_ACTIVE");
    expect(readTask(id)?.goal).toBe("first goal");
  });

  it("non-owner cannot cancel or finish; owner close records distinct outcomes", () => {
    const { id } = setup();
    enableTask(id, "goal A", "owner");
    expect(() => cancelTask(id, "intruder")).toThrowError(/read-only|owned by/);
    expect(() => finishTask(id, "intruder", "done")).toThrowError(/read-only|owned by/);
    expect(readTask(id)?.state).toBe("active");

    const cancelled = cancelTask(id, "owner", "user changed mind");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.outcome).toBe("cancelled");
    expect(cancelled.outcomeNote).toBe("user changed mind");

    enableTask(id, "goal B", "owner");
    const done = finishTask(id, "owner", "done", "shipped");
    expect(done.state).toBe("done");
    expect(done.outcome).toBe("done");

    enableTask(id, "goal C", "owner");
    const blocked = finishTask(id, "owner", "blocked", "needs API key");
    expect(blocked.state).toBe("blocked");
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.outcome).not.toBe(done.outcome);
  });

  it("closed tasks reject further mutation; a new task can be enabled after close", () => {
    const { id } = setup();
    const first = enableTask(id, "goal", "owner");
    finishTask(id, "owner", "done");
    expect(() => cancelTask(id, "owner")).toThrowError(TaskError);
    expect(() => finishTask(id, "owner", "done")).toThrowError(TaskError);
    expect(() => takeoverTask(id, "other")).toThrowError(TaskError);
    const second = enableTask(id, "next goal", "other");
    expect(second.taskId).not.toBe(first.taskId);
    expect(second.state).toBe("active");
    expect(second.ownerSessionId).toBe("other");
  });

  it("takeover transfers ownership to a non-owner and refuses the current owner", () => {
    const { id } = setup();
    const task = enableTask(id, "goal", "owner");
    expect(() => takeoverTask(id, "owner")).toThrowError(/already owns/);
    const taken = takeoverTask(id, "successor");
    expect(taken.ownerSessionId).toBe("successor");
    expect(taken.taskId).toBe(task.taskId);
    expect(taken.state).toBe("active");
    // Old owner is now read-only.
    expect(() => cancelTask(id, "owner")).toThrowError(/read-only|owned by/);
    // Second takeover by the new owner is refused.
    expect(() => takeoverTask(id, "successor")).toThrowError(/already owns/);
    // Takeover with no task at all is refused.
    expect(() => takeoverTask("missing-workspace", "someone")).toThrowError(TaskError);
  });

  it("waiting/timeout never changes ownership: only explicit ops touch the owner field", () => {
    const { id } = setup();
    const before = enableTask(id, "goal", "owner");
    // No mutation other than takeover/enable may rewrite the file; reading
    // repeatedly (the timeout path: nobody acts) leaves ownership intact.
    for (let i = 0; i < 3; i++) {
      expect(readTask(id)?.ownerSessionId).toBe("owner");
    }
    expect(readTask(id)).toEqual(before);
  });

  it("persists atomically with no tmp leftovers and rejects corrupt files as absent", () => {
    const { id } = setup();
    enableTask(id, "goal", "owner");
    const dir = process.env.C2C_STATE_DIR as string;
    const leftovers = fs
      .readdirSync(`${dir}/tasks`)
      .filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(fs.existsSync(taskFile(id))).toBe(true);
    fs.writeFileSync(taskFile(id), "{not json");
    expect(readTask(id)).toBeNull();
  });
});
