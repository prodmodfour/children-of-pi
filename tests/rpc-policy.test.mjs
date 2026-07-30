import assert from "node:assert/strict";
import test from "node:test";
import { assertAllowedChildRpcCommand } from "../rpc-policy.ts";

test("child model, thinking, and Pi setting changes are rejected", () => {
  for (const type of [
    "set_model", "cycle_model",
    "set_thinking_level", "cycle_thinking_level",
    "set_steering_mode", "set_follow_up_mode",
    "set_auto_compaction", "set_auto_retry",
    "set_session_name", "set_editor_text", "set_future_setting",
    "setStatus", "setWidget", "setTitle",
  ]) {
    assert.throws(
      () => assertAllowedChildRpcCommand({ type }),
      new RegExp(`does not allow changing child Pi settings \\(${type}\\)`),
    );
  }
});

test("non-setting RPC commands remain allowed", () => {
  for (const type of ["get_state", "prompt", "steer", "follow_up", "abort", "compact", "new_session"]) {
    assert.doesNotThrow(() => assertAllowedChildRpcCommand({ type }));
  }
});
