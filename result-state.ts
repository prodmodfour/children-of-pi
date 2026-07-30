import { resolve } from "node:path";

export type RunStatus = "running" | "settled" | "failed" | "aborted" | "exited";

export interface ResultState {
  answer: string | null;
  stopReason: string | null;
  errorMessage: string | null;
  pendingFileMutations: Map<string, string>;
  sessionChangedFiles: Set<string>;
}

export function createResultState(): ResultState {
  return {
    answer: null,
    stopReason: null,
    errorMessage: null,
    pendingFileMutations: new Map(),
    sessionChangedFiles: new Set(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromAssistant(message: Record<string, unknown>): string | null {
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .filter((part): part is Record<string, unknown> => isObject(part) && part.type === "text")
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Apply durable result state from a Pi RPC lifecycle event. */
export function applyResultEvent(state: ResultState, event: Record<string, unknown>, cwd: string): void {
  const type = String(event.type ?? "");

  if (type === "agent_start") {
    // Result fields describe the latest run. Session aggregates remain intact.
    state.answer = null;
    state.stopReason = null;
    state.errorMessage = null;
    state.pendingFileMutations.clear();
    return;
  }

  if (type === "message_end" && isObject(event.message) && event.message.role === "assistant") {
    // Always replace all latest-run fields, including for textless failures.
    state.answer = textFromAssistant(event.message);
    state.stopReason = typeof event.message.stopReason === "string" ? event.message.stopReason : null;
    state.errorMessage = typeof event.message.errorMessage === "string" ? event.message.errorMessage : null;
    return;
  }

  if (type === "tool_execution_start" && ["edit", "write"].includes(String(event.toolName))) {
    const args = isObject(event.args) ? event.args : null;
    if (typeof event.toolCallId === "string" && args && typeof args.path === "string") {
      state.pendingFileMutations.set(event.toolCallId, resolve(cwd, args.path));
    }
    return;
  }

  if (type === "tool_execution_end" && typeof event.toolCallId === "string") {
    const path = state.pendingFileMutations.get(event.toolCallId);
    state.pendingFileMutations.delete(event.toolCallId);
    if (path && event.isError === false) state.sessionChangedFiles.add(path);
  }
}

export function resultStatus(
  isStreaming: boolean,
  alive: boolean,
  exitCode: number | null,
  stopReason: string | null,
): RunStatus {
  if (isStreaming || stopReason === "toolUse") return "running";
  if (!alive && exitCode !== 0) return "exited";
  if (stopReason === "error") return "failed";
  if (stopReason === "aborted") return "aborted";
  return "settled";
}
