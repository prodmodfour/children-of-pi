import assert from "node:assert/strict";
import test from "node:test";
import {
  applyResultEvent,
  createResultState,
  resetContextScopedResultCaches,
  resultStatus,
} from "../result-state.ts";

const assistantEnd = (content, stopReason, errorMessage) => ({
  type: "message_end",
  message: { role: "assistant", content, stopReason, ...(errorMessage ? { errorMessage } : {}) },
});

test("textless model error replaces a previous successful answer", () => {
  const state = createResultState();
  applyResultEvent(state, { type: "agent_start" }, "/tmp/project");
  applyResultEvent(state, assistantEnd([{ type: "text", text: "old success" }], "stop"), "/tmp/project");
  applyResultEvent(state, { type: "agent_start" }, "/tmp/project");
  applyResultEvent(state, assistantEnd([], "error", "provider unavailable"), "/tmp/project");

  assert.equal(state.answer, null);
  assert.equal(state.stopReason, "error");
  assert.equal(state.errorMessage, "provider unavailable");
  assert.equal(resultStatus(false, true, null, state.stopReason), "failed");
});

test("abort after success cannot return the previous answer", () => {
  const state = createResultState();
  applyResultEvent(state, assistantEnd([{ type: "text", text: "old success" }], "stop"), "/tmp/project");
  applyResultEvent(state, { type: "agent_start" }, "/tmp/project");
  applyResultEvent(state, assistantEnd([], "aborted", "cancelled by parent"), "/tmp/project");

  assert.equal(state.answer, null);
  assert.equal(state.errorMessage, "cancelled by parent");
  assert.equal(resultStatus(false, true, null, state.stopReason), "aborted");
});

test("failed edits are not reported as session changed files", () => {
  const state = createResultState();
  applyResultEvent(state, {
    type: "tool_execution_start", toolCallId: "failed", toolName: "edit", args: { path: "a.ts" },
  }, "/tmp/project");
  applyResultEvent(state, {
    type: "tool_execution_end", toolCallId: "failed", toolName: "edit", isError: true,
  }, "/tmp/project");
  applyResultEvent(state, {
    type: "tool_execution_start", toolCallId: "ok", toolName: "write", args: { path: "b.ts" },
  }, "/tmp/project");
  applyResultEvent(state, {
    type: "tool_execution_end", toolCallId: "ok", toolName: "write", isError: false,
  }, "/tmp/project");

  assert.deepEqual([...state.sessionChangedFiles], ["/tmp/project/b.ts"]);
});

test("full context replacement clears every context-scoped result cache only", () => {
  const resultState = createResultState();
  resultState.answer = "old answer";
  resultState.stopReason = "error";
  resultState.errorMessage = "old error";
  resultState.pendingFileMutations.set("edit-1", "/tmp/project/pending.ts");
  resultState.sessionChangedFiles.add("/tmp/project/changed.ts");
  const caches = {
    resultState,
    lastAssistantText: "old compatibility answer",
    lastState: { sessionId: "old-session" },
    nextSequence: 42,
    events: [{ sequence: 42 }],
    instanceId: "stable-instance",
    usage: { inputTokens: 123 },
  };

  resetContextScopedResultCaches(caches);

  assert.equal(resultState.answer, null);
  assert.equal(resultState.stopReason, null);
  assert.equal(resultState.errorMessage, null);
  assert.equal(resultState.pendingFileMutations.size, 0);
  assert.equal(resultState.sessionChangedFiles.size, 0);
  assert.equal(caches.lastAssistantText, null);
  assert.equal(caches.lastState, null);
  assert.equal(caches.nextSequence, 42);
  assert.deepEqual(caches.events, [{ sequence: 42 }]);
  assert.equal(caches.instanceId, "stable-instance");
  assert.deepEqual(caches.usage, { inputTokens: 123 });
});

test("settled toolUse and clean process exit use lifecycle status", () => {
  assert.equal(resultStatus(false, true, null, "toolUse"), "settled");
  assert.equal(resultStatus(false, false, 0, "stop"), "exited");
  assert.equal(resultStatus(true, true, null, "error"), "running");
});

test("a second follow-up resets run fields but preserves session aggregates", () => {
  const state = createResultState();
  applyResultEvent(state, { type: "agent_start" }, "/tmp/project");
  applyResultEvent(state, assistantEnd([{ type: "text", text: "first" }], "stop"), "/tmp/project");
  state.sessionChangedFiles.add("/tmp/project/first.ts");

  applyResultEvent(state, { type: "agent_start" }, "/tmp/project");
  assert.equal(state.answer, null);
  assert.equal(state.stopReason, null);
  assert.deepEqual([...state.sessionChangedFiles], ["/tmp/project/first.ts"]);

  applyResultEvent(state, assistantEnd([{ type: "text", text: "second" }], "length"), "/tmp/project");
  assert.equal(state.answer, "second");
  assert.equal(state.stopReason, "length");
  assert.equal(resultStatus(false, true, null, state.stopReason), "settled");
});
