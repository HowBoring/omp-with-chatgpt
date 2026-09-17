import { afterEach, describe, expect, it } from "vitest";
import {
  appendExecutionRecord,
  latestExecutionRecord,
  readExecutionRecords,
  validateExecutedEvidence,
} from "../src/execution/records.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";
import { Workspace } from "../src/workspace/manager.js";

describe("execution record task/iteration binding", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): string {
    const stateDir = isolateStateDir();
    const workspaceDir = makeTmpDir("c2c-records");
    dirs.push(stateDir, workspaceDir);
    return new Workspace(workspaceDir).id;
  }

  function record(taskId: string, iteration: number, tests: string) {
    return {
      taskId,
      iteration,
      changedFiles: 1,
      tests,
      exitStatus: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  it("filters records by task and by task+iteration", () => {
    const wid = setup();
    appendExecutionRecord(wid, record("c2c_aaaa", 1, "10 passed"));
    appendExecutionRecord(wid, record("c2c_bbbb", 1, "20 passed"));
    appendExecutionRecord(wid, record("c2c_aaaa", 2, "30 passed"));

    expect(readExecutionRecords(wid, { taskId: "c2c_aaaa" }).map((r) => r.iteration)).toEqual([1, 2]);
    expect(readExecutionRecords(wid, { taskId: "c2c_aaaa", iteration: 2 })).toEqual([
      expect.objectContaining({ taskId: "c2c_aaaa", iteration: 2, tests: "30 passed" }),
    ]);
    expect(readExecutionRecords(wid, { taskId: "c2c_nope" })).toEqual([]);
    // Unfiltered default behavior is unchanged.
    expect(readExecutionRecords(wid).length).toBe(3);
  });

  it("latest per task is never confused across two tasks in one workspace", () => {
    const wid = setup();
    appendExecutionRecord(wid, record("c2c_aaaa", 1, "a1"));
    appendExecutionRecord(wid, record("c2c_bbbb", 1, "b1"));
    appendExecutionRecord(wid, record("c2c_aaaa", 2, "a2"));

    expect(latestExecutionRecord(wid, { taskId: "c2c_aaaa" })?.tests).toBe("a2");
    expect(latestExecutionRecord(wid, { taskId: "c2c_bbbb" })?.tests).toBe("b1");
    // Global latest is the most recent record overall (existing semantics).
    expect(latestExecutionRecord(wid)?.tests).toBe("a2");
  });

  it("validateExecutedEvidence requires a record matching task and iteration", () => {
    const wid = setup();
    appendExecutionRecord(wid, record("c2c_aaaa", 1, "10 passed"));

    const ok = validateExecutedEvidence(wid, "c2c_aaaa", 1);
    expect(ok.ok).toBe(true);

    // Wrong iteration and wrong task both fail even though records exist.
    expect(validateExecutedEvidence(wid, "c2c_aaaa", 2)).toMatchObject({ ok: false });
    expect(validateExecutedEvidence(wid, "c2c_bbbb", 1)).toMatchObject({ ok: false });
  });

  it("validateExecutedEvidence rejects malformed task and iteration input", () => {
    const wid = setup();
    expect(validateExecutedEvidence(wid, "", 0)).toMatchObject({ ok: false });
    expect(validateExecutedEvidence(wid, "c2c_aaaa", -1)).toMatchObject({ ok: false });
    expect(validateExecutedEvidence(wid, "c2c_aaaa", 1.5)).toMatchObject({ ok: false });
  });
});
