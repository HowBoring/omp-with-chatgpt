import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Workspace-level C2C task ownership (issue #4).
 *
 * One active task per workspace. The JSON file under `<stateDir>/tasks/`
 * is AUTHORITATIVE for ownership; OMP transcript entries may mirror it but
 * must never be consulted for ownership decisions.
 *
 * Ownership/liveness semantics (chosen because OMP exposes no cross-session
 * liveness signal — the verified `sessionManager` surface offers
 * `getSessionId()`/`getBranch()`/`getSessionDir()` but no way to list or
 * probe other live sessions, and `session_shutdown` only fires for the
 * session being shut down):
 *
 * - Takeover is an explicit user command (`/c2c-takeover`). It succeeds for
 *   any non-owner caller: "the owner has exited" is a user judgment, not a
 *   programmatic check, because the extension cannot observe other sessions.
 * - Takeover is refused only when the caller already owns the task
 *   (`ALREADY_OWNER`) or when there is no active task to take over.
 * - Waiting/timeout NEVER transfers ownership: nothing in this module runs
 *   on a timer or hook, so the owner field only changes via explicit
 *   takeover (or a fresh enable after the previous task closed).
 */

export type C2CTaskState = "active" | "done" | "blocked" | "cancelled";

/** Terminal outcomes. DONE, BLOCKED, and user cancellation are distinct. */
export type C2CTaskOutcome = "done" | "blocked" | "cancelled";

export interface C2CTask {
  version: 1;
  taskId: string;
  goal: string;
  state: C2CTaskState;
  ownerSessionId: string;
  createdAt: string;
  updatedAt: string;
  /** Set exactly once when the task leaves `active`. */
  outcome?: C2CTaskOutcome;
  outcomeNote?: string;
  iteration: number;
}

export type TaskErrorCode =
  | "EMPTY_GOAL"
  | "TASK_ACTIVE"
  | "NO_TASK"
  | "NO_ACTIVE_TASK"
  | "ALREADY_CLOSED"
  | "NOT_OWNER"
  | "ALREADY_OWNER";

export class TaskError extends Error {
  constructor(
    public code: TaskErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TaskError";
  }
}

const GOAL_LIMIT = 500;
const NOTE_LIMIT = 500;

function capText(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function taskFile(workspaceId: string): string {
  return path.join(getStateDir(), "tasks", `${workspaceId}.json`);
}

export function newTaskId(): string {
  return `c2c_${randomBytes(2).toString("hex")}`;
}

function isTask(value: unknown): value is C2CTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.taskId === "string" &&
    typeof task.goal === "string" &&
    (task.state === "active" ||
      task.state === "done" ||
      task.state === "blocked" ||
      task.state === "cancelled") &&
    typeof task.ownerSessionId === "string" &&
    typeof task.createdAt === "string" &&
    typeof task.updatedAt === "string"
  );
}

export function readTask(workspaceId: string): C2CTask | null {
  let raw: string;
  try {
    raw = fs.readFileSync(taskFile(workspaceId), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isTask(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic-ish persistence: write tmp + rename so readers never see a half write. */
function writeTaskAtomic(workspaceId: string, task: C2CTask): C2CTask {
  const file = taskFile(workspaceId);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup
    }
    throw err;
  }
  return task;
}

/** Explicit enablement: exactly one active task per workspace, owned by the caller. */
export function enableTask(workspaceId: string, goal: string, ownerSessionId: string): C2CTask {
  const trimmed = goal.trim();
  if (!trimmed) {
    throw new TaskError("EMPTY_GOAL", "usage: /c2c-enable <goal> — a goal is required");
  }
  const existing = readTask(workspaceId);
  if (existing && existing.state === "active") {
    throw new TaskError(
      "TASK_ACTIVE",
      `workspace already has active task ${existing.taskId} (owner session ${existing.ownerSessionId}); cancel, finish, or take over before enabling a new one`
    );
  }
  const now = new Date().toISOString();
  return writeTaskAtomic(workspaceId, {
    version: 1,
    taskId: newTaskId(),
    goal: capText(trimmed, GOAL_LIMIT),
    state: "active",
    ownerSessionId,
    createdAt: now,
    updatedAt: now,
    iteration: 0,
  });
}

function requireActive(task: C2CTask): void {
  if (task.state !== "active") {
    throw new TaskError(
      "ALREADY_CLOSED",
      `task ${task.taskId} is already ${task.state} (outcome=${task.outcome ?? "none"}); enable a new task for new work`
    );
  }
}

function requireOwner(task: C2CTask, callerSessionId: string): void {
  if (task.ownerSessionId !== callerSessionId) {
    throw new TaskError(
      "NOT_OWNER",
      `task ${task.taskId} is owned by session ${task.ownerSessionId}; session ${callerSessionId} has read-only access — use /c2c-status to inspect or /c2c-takeover to take ownership`
    );
  }
}

function closeTask(
  workspaceId: string,
  callerSessionId: string,
  state: C2CTaskState,
  outcome: C2CTaskOutcome,
  note: string | undefined
): C2CTask {
  const existing = readTask(workspaceId);
  if (!existing) {
    throw new TaskError("NO_TASK", "no C2C task for this workspace; use /c2c-enable <goal> first");
  }
  requireActive(existing);
  requireOwner(existing, callerSessionId);
  const trimmedNote = note?.trim();
  return writeTaskAtomic(workspaceId, {
    ...existing,
    state,
    outcome,
    outcomeNote: trimmedNote ? capText(trimmedNote, NOTE_LIMIT) : undefined,
    updatedAt: new Date().toISOString(),
  });
}

/** Owner-only user cancellation. Cancellation is NOT DONE. */
export function cancelTask(
  workspaceId: string,
  callerSessionId: string,
  note?: string
): C2CTask {
  return closeTask(workspaceId, callerSessionId, "cancelled", "cancelled", note);
}

/** Owner-only terminal close. `outcome` keeps DONE and BLOCKED distinct. */
export function finishTask(
  workspaceId: string,
  callerSessionId: string,
  outcome: "done" | "blocked",
  note?: string
): C2CTask {
  return closeTask(
    workspaceId,
    callerSessionId,
    outcome === "done" ? "done" : "blocked",
    outcome,
    note
  );
}

/**
 * Explicit ownership transfer to a non-owner session.
 * Refuses takeover by the current owner and takeover of closed tasks.
 */
export function takeoverTask(workspaceId: string, callerSessionId: string): C2CTask {
  const existing = readTask(workspaceId);
  if (!existing) {
    throw new TaskError("NO_TASK", "no C2C task for this workspace; use /c2c-enable <goal> first");
  }
  if (existing.state !== "active") {
    throw new TaskError(
      "NO_ACTIVE_TASK",
      `task ${existing.taskId} is already ${existing.state} (outcome=${existing.outcome ?? "none"}); use /c2c-enable <goal> to start a new task`
    );
  }
  if (existing.ownerSessionId === callerSessionId) {
    throw new TaskError(
      "ALREADY_OWNER",
      `session ${callerSessionId} already owns task ${existing.taskId}; no takeover needed`
    );
  }
  return writeTaskAtomic(workspaceId, {
    ...existing,
    ownerSessionId: callerSessionId,
    updatedAt: new Date().toISOString(),
  });
}

/** One-line ownership-aware summary for /c2c-status. */
export function formatTaskSummary(task: C2CTask | null, viewerSessionId?: string): string {
  if (!task) {
    return "none (no C2C task for this workspace; use /c2c-enable <goal>)";
  }
  const base =
    task.state === "active"
      ? `active ${task.taskId} owner=${task.ownerSessionId} goal="${task.goal}" updated=${task.updatedAt}`
      : `${task.state} ${task.taskId} outcome=${task.outcome ?? "none"} goal="${task.goal}" updated=${task.updatedAt}`;
  if (!viewerSessionId || task.state !== "active") return base;
  return viewerSessionId === task.ownerSessionId
    ? `${base} (you are the owner)`
    : `${base} (owned by another session; read-only)`;
}
