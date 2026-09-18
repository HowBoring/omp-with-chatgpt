import type { C2CTask } from "./task-state.js";

/**
 * Normal-path protocol gates (issue #7).
 *
 * While the owning session's active task awaits a ChatGPT PLAN or REVIEW,
 * registered modifying tool calls are blocked before execution, and a
 * session awaiting review may not finish. This is workflow enforcement for
 * cooperative OMP paths — not a security sandbox: Eval host bridge calls,
 * spawned subprocesses, and other non-tool execution paths are out of
 * scope by design.
 */

/** Modifying tools gated while awaiting PLAN or REVIEW. Read-only tools are never gated. */
export const GATED_TOOLS: readonly string[] = [
  "bash",
  "edit",
  "write",
  "apply_patch",
  "eval",
  "task",
];

export type GateVerdict = { blocked: true; reason: string } | { blocked: false };

/**
 * Gate decision for one tool call. While an active task's checkpoint waits on
 * a ChatGPT PLAN or REVIEW, modifying tools are blocked for EVERY session in
 * the workspace — the owner, its subagents (whose work belongs to the owning
 * task, issue #8), and any other session. Review must complete before new
 * edits land. Closed/absent tasks, non-gated tools, and non-waiting states
 * pass through untouched.
 */
export function toolGateVerdict(
  task: C2CTask | null,
  callerSessionId: string,
  toolName: string
): GateVerdict {
  if (!GATED_TOOLS.includes(toolName)) return { blocked: false };
  if (!task || task.state !== "active") return { blocked: false };
  const waiting = task.checkpoint?.waitingFor;
  if (waiting === "GPT_PLAN") {
    return {
      blocked: true,
      reason: `C2C task ${task.taskId} awaits a ChatGPT PLAN (iteration ${task.iteration}); modifying tools are paused until the plan arrives. Use /c2c-status to inspect or /c2c-cancel to abort.`,
    };
  }
  if (waiting === "GPT_REVIEW") {
    return {
      blocked: true,
      reason: `C2C task ${task.taskId} awaits ChatGPT REVIEW (iteration ${task.iteration}); modifying tools are paused until the review arrives. Use /c2c-status to inspect or /c2c-cancel to abort.`,
    };
  }
  return { blocked: false };
}

/**
 * Completion guard verdict for session_stop. A session whose task awaits
 * ChatGPT REVIEW may not finish the C2C task as complete.
 */
export function stopGateVerdict(
  task: C2CTask | null,
  callerSessionId: string
): GateVerdict {
  if (!task || task.state !== "active") return { blocked: false };
  if (task.ownerSessionId !== callerSessionId) return { blocked: false };
  if (task.checkpoint?.waitingFor !== "GPT_REVIEW") return { blocked: false };
  return {
    blocked: true,
    reason: `C2C task ${task.taskId} (iteration ${task.iteration}) awaits ChatGPT REVIEW; the task cannot be completed before the review arrives. Wait for REVIEW, or /c2c-cancel to abandon.`,
  };
}
