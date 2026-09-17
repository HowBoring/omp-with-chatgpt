import fs from "node:fs";
import { getStateDir } from "../config/paths.js";
import { readSession, sessionFile, type SavedSession } from "../session/state.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import { Workspace } from "../workspace/manager.js";

interface MinimalExtensionApi {
  setLabel(label: string): void;
  registerCommand(name: string, options: {
    description: string;
    handler: (args: string, ctx: { ui: { notify(message: string, level?: string): void }; cwd: string }) => Promise<void> | void;
  }): void;
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

export function buildStatusMessage(cwd: string): string {
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
  }
  return (
    `${PRODUCT_NAME} ${VERSION}\n` +
    `workspace=${workspaceRoot}\n` +
    `stateDir=${getStateDir()}\n` +
    `state=${summary}`
  );
}

export default function ompWithChatGPT(pi: MinimalExtensionApi): void {
  pi.setLabel(PRODUCT_NAME);

  pi.registerCommand("c2c-status", {
    description: "Show OMP C2C status: workspace, version, state location, and active task",
    handler: async (_args, ctx) => {
      ctx.ui.notify(buildStatusMessage(ctx.cwd), "info");
    },
  });
}
