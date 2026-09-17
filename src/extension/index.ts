import fs from "node:fs";
import { getStateDir } from "../config/paths.js";
import { readSession, sessionFile, type SavedSession } from "../session/state.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";
import {
  cancelTask,
  enableTask,
  finishTask,
  formatTaskSummary,
  mirrorOf,
  readTask,
  reconcileMirror,
  takeoverTask,
  updateCheckpoint,
  type CheckpointMirror,
  type CheckpointPatch,
  type C2CTask,
} from "./task-state.js";

/** Transcript custom-entry type for the checkpoint mirror (issue #5). */
export const CHECKPOINT_MIRROR_TYPE = "com.omp-with-chatgpt.c2c.checkpoint";

interface CommandContext {
  ui: { notify(message: string, level?: string): void };
  cwd: string;
  sessionManager: { getSessionId(): string; getBranch?(): unknown[] };
}

interface MinimalExtensionApi {
  setLabel(label: string): void;
  appendEntry?(customType: string, data: unknown): void;
  on?(
    event: "session_start",
    handler: (event: unknown, ctx: CommandContext) => Promise<void> | void
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: CommandContext) => Promise<void> | void;
    }
  ): void;
}

/** Best-effort transcript mirror; the workspace task file stays authoritative. */
function mirrorTask(pi: MinimalExtensionApi, task: C2CTask): void {
  try {
    pi.appendEntry?.(CHECKPOINT_MIRROR_TYPE, mirrorOf(task));
  } catch {
    // Mirror failures never block the authoritative workspace write.
  }
}

/** Latest checkpoint mirror from the current transcript branch, if any. */
export function latestMirror(ctx: CommandContext): CheckpointMirror | null {
  let branch: unknown[];
  try {
    branch = ctx.sessionManager.getBranch?.() ?? [];
  } catch {
    return null;
  }
  let latest: CheckpointMirror | null = null;
  for (const entry of branch) {
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record?.type === "custom" && record.customType === CHECKPOINT_MIRROR_TYPE) {
      latest = record.data as CheckpointMirror;
    }
  }
  return latest;
}

/**
 * Parse `/c2c-checkpoint` key=value args into a CheckpointPatch.
 * Keys: state, waiting, iter, chat, project, mode, connector.
 */
export function parseCheckpointArgs(args: string): CheckpointPatch {
  const patch: CheckpointPatch = {};
  const binding: NonNullable<CheckpointPatch["binding"]> = {};
  for (const pair of args.trim().split(/\s+/)) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = pair.slice(eq + 1);
    if (key === "state") patch.protocolState = value as CheckpointPatch["protocolState"];
    else if (key === "waiting") patch.waitingFor = value as CheckpointPatch["waitingFor"];
    else if (key === "iter") patch.iteration = Number(value);
    else if (key === "chat") binding.chatUrl = value;
    else if (key === "project") binding.projectUrl = value;
    else if (key === "mode") binding.mode = value as "long-chat" | "project";
    else if (key === "connector") binding.connectorName = value;
  }
  if (Object.keys(binding).length > 0) patch.binding = binding;
  return patch;
}

/**
 * Render the workspace-level C2C state summary.
 *
 * - `fileExists === false` → `no state` (session file missing for this workspace)
 * - file present but no task/checkpoint → `empty`
 * - otherwise the active task/checkpoint identity.
 */
export function formatStateSummary(session: SavedSession | null, fileExists: boolean): string {
  if (!fileExists || !session) {
    return "no state (no session file for this workspace)";
  }
  const checkpoint = session.checkpoint;
  const taskId = checkpoint?.taskId ?? session.taskId;
  if (!taskId) {
    return "empty (session present, no active task)";
  }
  const iteration = checkpoint?.iteration ?? session.iteration ?? 0;
  if (checkpoint) {
    return `active task ${taskId} (iteration ${iteration}, ${checkpoint.protocolState}, waiting for ${checkpoint.waitingFor})`;
  }
  return `active task ${taskId} (iteration ${iteration}, no checkpoint)`;
}

/**
 * Parse `/c2c-finish` args. A leading `blocked` (or `done`) selects the
 * terminal outcome; anything after it is the outcome note. Without a leading
 * keyword the whole args string is the note and the outcome is DONE.
 */
export function parseFinishArgs(args: string): {
  outcome: "done" | "blocked";
  note: string | undefined;
} {
  const trimmed = args.trim();
  if (trimmed === "") return { outcome: "done", note: undefined };
  const [first, ...rest] = trimmed.split(/\s+/);
  const keyword = (first ?? "").toLowerCase();
  if (keyword === "blocked") {
    const note = rest.join(" ").trim();
    return { outcome: "blocked", note: note === "" ? undefined : note };
  }
  if (keyword === "done") {
    const note = rest.join(" ").trim();
    return { outcome: "done", note: note === "" ? undefined : note };
  }
  return { outcome: "done", note: trimmed };
}

function openWorkspace(cwd: string): Workspace {
  return new Workspace(cwd);
}

function callerSessionId(ctx: CommandContext): string {
  const id = ctx.sessionManager?.getSessionId?.();
  if (typeof id !== "string" || id === "") {
    throw new Error("unavailable OMP session id; retry from a live OMP session");
  }
  return id;
}

function viewerOrUndefined(ctx: CommandContext): string | undefined {
  try {
    return callerSessionId(ctx);
  } catch {
    return undefined;
  }
}

export function buildStatusMessage(cwd: string, viewerSessionId?: string): string {
  let workspaceRoot = cwd;
  let workspaceId: string | null = null;
  try {
    const workspace = new Workspace(cwd);
    workspaceRoot = workspace.root;
    workspaceId = workspace.id;
  } catch {
    // Keep the raw cwd when it cannot be opened as a workspace.
  }
  let summary: string;
  let taskSummary = "none (no C2C task for this workspace; use /c2c-enable <goal>)";
  let bindingLine: string | null = null;
  if (!workspaceId) {
    summary = "no state (no session file for this workspace)";
  } else {
    let fileExists = false;
    try {
      fileExists = fs.existsSync(sessionFile(workspaceId));
    } catch {
      fileExists = false;
    }
    let session: SavedSession | null = null;
    if (fileExists) {
      try {
        session = readSession(workspaceId);
      } catch {
        session = null;
      }
    }
    summary = formatStateSummary(session, fileExists);
    try {
      const task = readTask(workspaceId);
      taskSummary = formatTaskSummary(task, viewerSessionId);
      if (task?.binding && Object.keys(task.binding).length > 0) {
        const parts: string[] = [];
        if (task.binding.mode) parts.push(`mode=${task.binding.mode}`);
        if (task.binding.chatUrl) parts.push(`chat=${task.binding.chatUrl}`);
        if (task.binding.projectUrl) parts.push(`project=${task.binding.projectUrl}`);
        if (task.binding.connectorName) parts.push(`connector=${task.binding.connectorName}`);
        bindingLine = parts.join(" ");
      }
    } catch {
      taskSummary = "unreadable (task file present but could not be parsed)";
    }
  }
  return (
    `${PRODUCT_NAME} ${VERSION}\n` +
    `workspace=${workspaceRoot}\n` +
    `stateDir=${getStateDir()}\n` +
    `state=${summary}\n` +
    `task=${taskSummary}` +
    (bindingLine ? `\nbinding=${bindingLine}` : "")
  );
}

export default function ompWithChatGPT(pi: MinimalExtensionApi): void {
  pi.setLabel(PRODUCT_NAME);

  pi.on?.("session_start", (_event, ctx) => {
    // Passive restore (issue #5): reconcile the workspace task file with
    // the transcript mirror and report. Never writes workspace state from
    // the mirror and never sends external messages.
    try {
      const workspace = new Workspace(ctx.cwd);
      const result = reconcileMirror(readTask(workspace.id), latestMirror(ctx));
      if (!result.authoritative && !result.mirror) return;
      const lines: string[] = [];
      if (result.authoritative) {
        lines.push(
          `restored C2C task state: ${formatTaskSummary(result.authoritative, viewerOrUndefined(ctx))}`
        );
      }
      if (result.mirrorStale && result.mirror) {
        lines.push(
          `stale transcript mirror ignored: task ${result.mirror.taskId} rev=${result.mirror.revision} is older than the workspace record`
        );
      }
      if (result.mirrorOrphaned && result.mirror) {
        lines.push(
          `transcript mirror for task ${result.mirror.taskId} has no workspace task file; informational only, no state changed`
        );
      }
      if (lines.length > 0) ctx.ui.notify(lines.join("\n"), "info");
    } catch {
      // Restore is advisory; never break session start.
    }
  });

  pi.registerCommand("c2c-status", {
    description: "Show OMP C2C status: workspace, version, state location, and active task",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildStatusMessage(ctx.cwd, viewerOrUndefined(ctx)), "info");
    },
  });

  pi.registerCommand("c2c-enable", {
    description: "Enable C2C for one goal; creates the workspace's single active task owned by this session",
    handler: async (args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const task = enableTask(workspace.id, args, callerSessionId(ctx));
      mirrorTask(pi, task);
      ctx.ui.notify(
        `enabled C2C task ${task.taskId} (owner session ${task.ownerSessionId})\ngoal="${task.goal}"`,
        "info"
      );
    },
  });

  pi.registerCommand("c2c-cancel", {
    description: "Cancel the active C2C task (owner only; cancellation is not DONE)",
    handler: async (args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const note = args.trim() === "" ? undefined : args.trim();
      const task = cancelTask(workspace.id, callerSessionId(ctx), note);
      mirrorTask(pi, task);
      ctx.ui.notify(`cancelled C2C task ${task.taskId} (outcome=cancelled, not DONE)`, "info");
    },
  });

  pi.registerCommand("c2c-finish", {
    description:
      "Close the active C2C task as DONE (owner only); `/c2c-finish blocked <reason>` records BLOCKED",
    handler: async (args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const { outcome, note } = parseFinishArgs(args);
      const task = finishTask(workspace.id, callerSessionId(ctx), outcome, note);
      mirrorTask(pi, task);
      ctx.ui.notify(`closed C2C task ${task.taskId} (outcome=${task.outcome})`, "info");
    },
  });

  pi.registerCommand("c2c-takeover", {
    description:
      "Take ownership of the active C2C task (explicit user command; use after the owning session has exited)",
    handler: async (_args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const task = takeoverTask(workspace.id, callerSessionId(ctx));
      mirrorTask(pi, task);
      ctx.ui.notify(
        `session ${task.ownerSessionId} now owns C2C task ${task.taskId}\ngoal="${task.goal}"`,
        "info"
      );
    },
  });

  pi.registerCommand("c2c-checkpoint", {
    description:
      "Advance the protocol checkpoint of the active task (owner only). Args: state=INIT|PLAN_RECEIVED|EXECUTING|EXECUTED_LOCAL|EXECUTED_SENT|DONE|BLOCKED waiting=none|GPT_PLAN|GPT_REVIEW|USER iter=N chat=<url> project=<url> mode=long-chat|project connector=<name>",
    handler: async (args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const current = readTask(workspace.id);
      if (!current) {
        throw new Error("no C2C task for this workspace; use /c2c-enable <goal> first");
      }
      const patch = parseCheckpointArgs(args);
      const task = updateCheckpoint(workspace.id, callerSessionId(ctx), current.revision, patch);
      mirrorTask(pi, task);
      ctx.ui.notify(
        `checkpoint ${task.checkpoint?.protocolState ?? "unchanged"} (task ${task.taskId}, rev=${task.revision}, iter=${task.iteration})`,
        "info"
      );
    },
  });
}
