import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertAllowedChildRpcCommand,
  childPiSpawnArgs,
  isSameCanonicalDirectory,
} from "../rpc-policy.ts";

test("child spawn sets explicit trust while preserving local model and thinking settings", () => {
  assert.deepEqual(childPiSpawnArgs(true, false), [
    "--mode", "rpc", "--no-session", "--no-approve",
  ]);
  assert.deepEqual(childPiSpawnArgs(false, true), [
    "--mode", "rpc", "--no-session", "--tools", "read,grep,find,ls", "--approve",
  ]);
  for (const args of [
    childPiSpawnArgs(true, true),
    childPiSpawnArgs(true, false),
    childPiSpawnArgs(false, true),
    childPiSpawnArgs(false, false),
  ]) {
    assert.equal(args.filter((arg) => arg === "--approve" || arg === "--no-approve").length, 1);
    assert.equal(args.includes("--provider"), false);
    assert.equal(args.includes("--model"), false);
    assert.equal(args.includes("--thinking"), false);
  }
});

test("canonical cwd comparison permits only the same real directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "children-of-pi-trust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, "parent");
  const other = join(root, "other");
  const alias = join(root, "parent-alias");
  mkdirSync(parent);
  mkdirSync(other);
  symlinkSync(parent, alias, "dir");

  assert.equal(isSameCanonicalDirectory(parent, parent), true);
  assert.equal(isSameCanonicalDirectory(parent, join(parent, ".")), true);
  assert.equal(isSameCanonicalDirectory(parent, alias), true);
  assert.equal(isSameCanonicalDirectory(parent, other), false);
  assert.equal(isSameCanonicalDirectory(parent, join(root, "missing")), false);
});

test("child model, thinking, and Pi setting changes are rejected", () => {
  for (const type of [
    "set_model", "cycle_model",
    "set_thinking_level", "cycle_thinking_level",
    "set_steering_mode", "set_follow_up_mode",
    "set_auto_compaction", "set_auto_retry",
    "set_session_name", "set_editor_text", "set_future_setting",
    "setStatus", "setWidget", "setTitle",
  ]) {
    for (const write of [false, true]) {
      assert.throws(
        () => assertAllowedChildRpcCommand({ type }, write),
        new RegExp(`does not allow changing child Pi settings \\(${type}\\)`),
      );
    }
  }
});

test("direct RPC bash is blocked only for read-only children", () => {
  assert.throws(
    () => assertAllowedChildRpcCommand({ type: "bash", command: "touch escaped" }, false),
    /does not allow direct RPC bash commands for read-only children/,
  );
  assert.doesNotThrow(
    () => assertAllowedChildRpcCommand({ type: "bash", command: "printf writable" }, true),
  );
});

test("non-setting RPC commands remain allowed", () => {
  for (const type of ["get_state", "prompt", "steer", "follow_up", "abort", "compact", "new_session"]) {
    for (const write of [false, true]) {
      assert.doesNotThrow(() => assertAllowedChildRpcCommand({ type }, write));
    }
  }
});
