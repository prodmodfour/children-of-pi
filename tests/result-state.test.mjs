import assert from "node:assert/strict";
import test from "node:test";
import { applyResultEvent, createResultState, resultStatus } from "../result-state.ts";

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
