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
  readTask,
  takeoverTask,
} from "./task-state.js";

interface CommandContext {
  ui: { notify(message: string, level?: string): void };
  cwd: string;
  sessionManager: { getSessionId(): string };
}

interface MinimalExtensionApi {
  setLabel(label: string): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string, ctx: CommandContext) => Promise<void> | void;
    }
  ): void;
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
      taskSummary = formatTaskSummary(readTask(workspaceId), viewerSessionId);
    } catch {
      taskSummary = "unreadable (task file present but could not be parsed)";
    }
  }
  return (
    `${PRODUCT_NAME} ${VERSION}\n` +
    `workspace=${workspaceRoot}\n` +
    `stateDir=${getStateDir()}\n` +
    `state=${summary}\n` +
    `task=${taskSummary}`
  );
}

export default function ompWithChatGPT(pi: MinimalExtensionApi): void {
  pi.setLabel(PRODUCT_NAME);

  pi.registerCommand("c2c-status", {
    description: "Show OMP C2C status: workspace, version, state location, and active task",
    handler: async (_args, ctx) => {
      let viewer: string | undefined;
      try {
        viewer = callerSessionId(ctx);
      } catch {
        viewer = undefined;
      }
      ctx.ui.notify(buildStatusMessage(ctx.cwd, viewer), "info");
    },
  });

  pi.registerCommand("c2c-enable", {
    description: "Enable C2C for one goal; creates the workspace's single active task owned by this session",
    handler: async (args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const task = enableTask(workspace.id, args, callerSessionId(ctx));
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
      ctx.ui.notify(`closed C2C task ${task.taskId} (outcome=${task.outcome})`, "info");
    },
  });

  pi.registerCommand("c2c-takeover", {
    description:
      "Take ownership of the active C2C task (explicit user command; use after the owning session has exited)",
    handler: async (_args, ctx) => {
      const workspace = openWorkspace(ctx.cwd);
      const task = takeoverTask(workspace.id, callerSessionId(ctx));
      ctx.ui.notify(
        `session ${task.ownerSessionId} now owns C2C task ${task.taskId}\ngoal="${task.goal}"`,
        "info"
      );
    },
  });
}
