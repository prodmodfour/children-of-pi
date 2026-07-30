import assert from "node:assert/strict";
import test from "node:test";
import {
  accessMarker, formatBioActor, formatCost, formatTokens, isNonBlankBio, preview,
} from "../ui/format.ts";
import { extractResultText, parseJsonResult, summarizeEvents } from "../ui/parse-result.ts";
import { classifyChild, footerParts, footerText, footerTone } from "../ui/status.ts";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

test("every lifecycle state maps to the intended category", () => {
  assert.equal(classifyChild({ alive: true, isStreaming: true, stopReason: null }), "running");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: null }), "idle");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: "stop" }), "settled");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: "error" }), "failed");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: "aborted" }), "aborted");
  assert.equal(classifyChild({ alive: false, isStreaming: false, stopReason: "stop" }), "exited");
});

test("footer omits zero categories and no children clears it", () => {
  assert.equal(footerText(footerParts([])), undefined);
  assert.equal(footerText(footerParts([
    { alive: true, isStreaming: true, stopReason: null },
    { alive: true, isStreaming: false, stopReason: "stop" },
  ])), "subagents: 1 running · 1 settled");
});

test("running takes precedence over intermediate or failed stop reasons", () => {
  assert.equal(classifyChild({ alive: true, isStreaming: true, stopReason: "error" }), "running");
  assert.equal(footerTone(footerParts([{ alive: true, isStreaming: true, stopReason: "error" }])), "accent");
});

test("failed, aborted, and exited children are never counted as settled", () => {
  const parts = footerParts([
    { alive: true, isStreaming: false, stopReason: "error" },
    { alive: true, isStreaming: false, stopReason: "aborted" },
    { alive: false, isStreaming: false, stopReason: "stop" },
  ]);
  assert.deepEqual(parts, [
    { category: "failed", count: 1 },
    { category: "aborted", count: 1 },
    { category: "exited", count: 1 },
  ]);
  assert.equal(footerTone(parts), "error");
});

test("invalid and truncated JSON falls back to original text", () => {
  for (const raw of ["not json", '{"id":"agent-1"', "[Output truncated]"]) {
    const result = deepFreeze({ content: [{ type: "text", text: raw }], details: { untouched: true }, isError: false });
    assert.deepEqual(parseJsonResult(result), { raw, value: null });
  }
});

test("partial spawn and missing result content are safe to inspect", () => {
  const partial = deepFreeze({ content: [{ type: "text", text: "Starting agent-7..." }], details: { id: "agent-7" } });
  assert.equal(extractResultText(partial), "Starting agent-7...");
  assert.equal(extractResultText({}), "");
  assert.equal(extractResultText({ content: [{ type: "image", data: "x" }, null] }), "");
});

test("parser and view helpers do not mutate AgentToolResult fields", () => {
  const result = deepFreeze({
    content: [{ type: "text", text: '{"id":"agent-1","status":"settled"}' }],
    details: { id: "agent-1", truncated: false },
    isError: false,
  });
  const before = structuredClone(result);
  parseJsonResult(result);
  extractResultText(result);
  assert.deepEqual(result, before);
  assert.deepEqual({ content: result.content, details: result.details, isError: result.isError }, before);
});

test("authoritative event status distinguishes failed, aborted, and idle batches", () => {
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: "error" }), "failed");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: "aborted" }), "aborted");
  assert.equal(classifyChild({ alive: true, isStreaming: false, stopReason: null }), "idle");
});

test("authoritative list status does not depend on assistant text", () => {
  const statuses = new Map([
    ["textless", classifyChild({ alive: true, isStreaming: false, stopReason: "error" })],
    ["with-text", classifyChild({ alive: true, isStreaming: false, stopReason: "error" })],
  ]);
  assert.equal(statuses.get("textless"), "failed");
  assert.equal(statuses.get("with-text"), "failed");
});

test("event summaries preserve ranges and hasMore", () => {
  const input = deepFreeze({
    hasMore: true,
    events: [
      { sequence: 32, event: { type: "tool_execution_start" } },
      { sequence: 34, event: { type: "message_end" } },
      { sequence: 39, event: { type: "agent_settled" } },
    ],
  });
  assert.deepEqual(summarizeEvents(input), {
    count: 3, firstSequence: 32, lastSequence: 39, hasMore: true,
    tools: 1, messages: 1, settlements: 1, exits: 0, protocolErrors: 0,
  });
});

test("bio presentation helpers distinguish blank metadata and format audit actors", () => {
  assert.equal(isNonBlankBio({ text: "", revision: 0 }), false);
  assert.equal(isNonBlankBio({ text: "knows the replay path", revision: 1 }), true);
  assert.equal(formatBioActor({ kind: "parent", sessionId: "abc", name: "Planner" }), "Planner (parent:abc)");
  assert.equal(formatBioActor({ kind: "human", via: "pi-tui", parentSessionId: "abc" }), "human via pi-tui (abc)");
  assert.equal(formatBioActor({ kind: "system", reason: "context-reset" }), "system/context-reset");
  assert.equal(formatBioActor(null), "never");
});

test("formatting is deterministic, unicode-safe, and labels session aggregates explicitly", async () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1_200), "1.2k");
  assert.equal(formatTokens(42_700), "43k");
  assert.equal(formatTokens(1_300_000), "1.3M");
  assert.equal(formatCost(0.41), "$0.41");
  assert.equal(preview("😀😀😀", 2), "😀…");
  assert.equal(accessMarker(true), "RW");
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../ui/renderers.ts", import.meta.url), "utf8"));
  assert.match(source, /Session usage:/);
  assert.match(source, /Session changed files/);
  assert.match(source, /Blank bios add no collapsed noise/);
  assert.match(source, /Updated by:/);
  assert.match(source, /Updated at:/);
  assert.match(source, /Revision /);
});
