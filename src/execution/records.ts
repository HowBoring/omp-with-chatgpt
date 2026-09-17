import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ensureDir, getStateDir } from "../config/paths.js";

/**
 * Lightweight execution records written by the OMP harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export const executionRecordSchema = z.object({
  taskId: z.string(),
  iteration: z.number().int().nonnegative(),
  changedFiles: z.union([z.array(z.string()), z.number().int().nonnegative()]),
  tests: z.string().nullable(),
  exitStatus: z.string(),
  timestamp: z.string(),
  notes: z.string().optional(),
  outputId: z.number().int().positive().optional(),
  outputAvailable: z.boolean().optional(),
});

export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

function recordsFile(workspaceId: string): string {
  const dir = ensureDir(path.join(getStateDir(), "executions"));
  return path.join(dir, `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord): void {
  const file = recordsFile(workspaceId);
  fs.appendFileSync(file, JSON.stringify(executionRecordSchema.parse(record)) + "\n", { mode: 0o600 });
}

export interface ExecutionRecordFilter {
  /** Exact task id match. */
  taskId?: string;
  /** Exact iteration match. */
  iteration?: number;
  /** Max records returned (default 10, min 1). */
  limit?: number;
}

/**
 * Read execution records for a workspace, newest-first internally, returned
 * oldest-first. Optional task/iteration filters scope the result so two
 * tasks in one workspace never share a "latest" view.
 */
export function readExecutionRecords(
  workspaceId: string,
  filter: ExecutionRecordFilter = {}
): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  const requestedLimit = Math.max(1, Math.floor(filter.limit ?? 10));
  for (let index = lines.length - 1; index >= 0 && records.length < requestedLimit; index--) {
    try {
      const record = executionRecordSchema.safeParse(JSON.parse(lines[index]));
      if (!record.success) continue;
      if (filter.taskId !== undefined && record.data.taskId !== filter.taskId) continue;
      if (filter.iteration !== undefined && record.data.iteration !== filter.iteration) continue;
      records.push(record.data);
    } catch {
      // skip corrupt lines
    }
  }
  return records.reverse();
}

export function latestExecutionRecord(
  workspaceId: string,
  filter: ExecutionRecordFilter = {}
): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, { ...filter, limit: 1 });
  return records[records.length - 1] ?? null;
}

export type ExecutedEvidenceResult =
  | { ok: true; record: ExecutionRecord }
  | { ok: false; reason: string };

/**
 * EXECUTED-path evidence check (issue #6): before a task's iteration goes
 * to review, a matching execution record must exist for exactly that task
 * and iteration.
 */
export function validateExecutedEvidence(
  workspaceId: string,
  taskId: string,
  iteration: number
): ExecutedEvidenceResult {
  if (!taskId.trim()) {
    return { ok: false, reason: "task id is empty" };
  }
  if (!Number.isInteger(iteration) || iteration < 0) {
    return { ok: false, reason: `iteration must be a non-negative integer, got ${iteration}` };
  }
  const record = latestExecutionRecord(workspaceId, { taskId, iteration });
  if (!record) {
    return {
      ok: false,
      reason: `no execution record for task ${taskId} iteration ${iteration}; record evidence before sending EXECUTED`,
    };
  }
  return { ok: true, record };
}
