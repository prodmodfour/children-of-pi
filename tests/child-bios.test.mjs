import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildBio,
  MAX_BIO_CODEPOINTS,
  createAgentBio,
  createChildIdentity,
  formatChildAddress,
  isSuccessfulChildContextReplacement,
  normalizeBioText,
  parseExternalBioActor,
} from "../child-bios.ts";

const parent = (name = "Planner") => ({
  kind: "parent",
  sessionId: "parent-session-1",
  name,
});

test("new children receive distinct stable instance identities and canonical addresses", () => {
  const first = createChildIdentity("agent-1", "parent-session-1");
  const second = createChildIdentity("agent-2", "parent-session-1");

  assert.match(first.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal(first.address, formatChildAddress("parent-session-1", first.instanceId));
  assert.equal(first.ownerSessionId, "parent-session-1");
  assert.equal(first.ownerParentSessionId, "parent-session-1");
});

test("new bios use the compatible blank revision-zero record", () => {
  assert.deepEqual(createAgentBio(), {
    text: "",
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    stale: false,
  });
  assert.deepEqual(new ChildBio().get(), createAgentBio());
});

test("bio text normalizes CRLF while preserving Markdown, line breaks, and whitespace", () => {
  const input = "  # Context\r\n\r\nkept\rline\n  ";
  assert.equal(normalizeBioText(input), "  # Context\n\nkept\rline\n  ");
});

test("bio text is limited by Unicode code points rather than UTF-16 units", () => {
  assert.equal(normalizeBioText("😀".repeat(MAX_BIO_CODEPOINTS)), "😀".repeat(MAX_BIO_CODEPOINTS));
  assert.throws(
    () => normalizeBioText("😀".repeat(MAX_BIO_CODEPOINTS + 1)),
    /at most 2000 Unicode code points/,
  );
});

test("set and clear use CAS, increment revisions, and attribute the derived actor", () => {
  let tick = 0;
  const bio = new ChildBio(() => `2026-07-30T00:00:0${++tick}.000Z`);

  assert.deepEqual(bio.set("inspected persistence", parent(), { expectedRevision: 0 }), {
    success: true,
    bio: {
      text: "inspected persistence",
      revision: 1,
      updatedAt: "2026-07-30T00:00:01.000Z",
      updatedBy: parent(),
      stale: false,
    },
  });
  assert.deepEqual(bio.clear(parent("Reviewer"), { expectedRevision: 1 }), {
    success: true,
    bio: {
      text: "",
      revision: 2,
      updatedAt: "2026-07-30T00:00:02.000Z",
      updatedBy: parent("Reviewer"),
      stale: false,
    },
  });
});

test("missing or stale expectedRevision returns the current bio without overwriting", () => {
  const bio = new ChildBio(() => "2026-07-30T00:00:00.000Z");
  const missing = bio.set("not written", parent());
  assert.deepEqual(missing, {
    success: false,
    conflict: true,
    expectedRevision: null,
    current: createAgentBio(),
  });

  assert.equal(bio.set("current", parent(), { expectedRevision: 0 }).success, true);
  const stale = bio.set("not written", parent(), { expectedRevision: 0 });
  assert.equal(stale.success, false);
  assert.equal(stale.conflict, true);
  assert.equal(stale.expectedRevision, 0);
  assert.equal(stale.current.text, "current");
  assert.equal(stale.current.revision, 1);
  assert.equal(bio.get().text, "current");
});

test("force overwrites only when explicitly true", () => {
  const bio = new ChildBio(() => "2026-07-30T00:00:00.000Z");
  assert.equal(bio.set("first", parent(), { expectedRevision: 0 }).success, true);
  assert.equal(bio.set("blocked", parent(), { force: false }).success, false);
  const forced = bio.set("forced", parent(), { force: true });
  assert.equal(forced.success, true);
  assert.equal(forced.bio.text, "forced");
  assert.equal(forced.bio.revision, 2);
});

test("successful context replacement clears the bio with a system audit revision", () => {
  const times = ["2026-07-30T00:00:01.000Z", "2026-07-30T00:00:02.000Z"];
  const bio = new ChildBio(() => times.shift());
  bio.set("old context", parent(), { expectedRevision: 0 });

  assert.deepEqual(bio.resetContext(), {
    text: "",
    revision: 2,
    updatedAt: "2026-07-30T00:00:02.000Z",
    updatedBy: { kind: "system", reason: "context-reset" },
    stale: false,
  });
  assert.equal(bio.history().length, 2);
});

test("only successful, non-cancelled full-session replacements reset context", () => {
  for (const command of ["new_session", "switch_session", "fork", "clone"]) {
    assert.equal(isSuccessfulChildContextReplacement({
      type: "response", command, success: true, data: { cancelled: false },
    }), true);
  }
  assert.equal(isSuccessfulChildContextReplacement({
    type: "response", command: "new_session", success: false,
  }), false);
  assert.equal(isSuccessfulChildContextReplacement({
    type: "response", command: "new_session", success: true, data: { cancelled: true },
  }), false);
  assert.equal(isSuccessfulChildContextReplacement({
    type: "response", command: "compact", success: true,
  }), false);
  assert.equal(isSuccessfulChildContextReplacement({
    type: "response", command: "set_model", success: true,
  }), false);
});

test("compaction and ordinary work preserve a child bio", () => {
  const bio = new ChildBio(() => "2026-07-30T00:00:00.000Z");
  bio.set("context retained through compaction", parent(), { expectedRevision: 0 });
  const compactionResponse = { type: "response", command: "compact", success: true };
  if (isSuccessfulChildContextReplacement(compactionResponse)) bio.resetContext();
  assert.equal(bio.get().text, "context retained through compaction");
  assert.equal(bio.get().revision, 1);
});

test("child audit history is bounded and returned as defensive copies", () => {
  let tick = 0;
  const bio = new ChildBio(() => `time-${++tick}`, 2);
  bio.set("one", parent(), { expectedRevision: 0 });
  bio.set("two", parent(), { expectedRevision: 1 });
  bio.set("three", parent(), { expectedRevision: 2 });

  const history = bio.history();
  assert.deepEqual(history.map((entry) => entry.revision), [2, 3]);
  history[0].text = "tampered";
  history[0].updatedBy.name = "tampered";
  assert.equal(bio.history()[0].text, "two");
  assert.equal(bio.history()[0].updatedBy.name, "Planner");
});

test("external actors are validated and system attribution cannot be supplied", () => {
  assert.deepEqual(parseExternalBioActor(parent()), parent());
  assert.deepEqual(
    parseExternalBioActor({ kind: "human", via: "whatspi", parentSessionId: "parent-session-1" }),
    { kind: "human", via: "whatspi", parentSessionId: "parent-session-1" },
  );
  assert.throws(
    () => parseExternalBioActor({ kind: "system", reason: "context-reset" }),
    /must be a parent or human actor/,
  );
  assert.throws(
    () => parseExternalBioActor({ kind: "parent", sessionId: "", name: null }),
    /actor.sessionId must be a non-empty string/,
  );
});
