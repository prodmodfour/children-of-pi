import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILDREN_OF_PI_CAPABILITIES,
  CHILDREN_OF_PI_CHANGED_CHANNEL,
  CHILDREN_OF_PI_REQUEST_CHANNEL,
  childrenOfPiResponseChannel,
  createChildrenOfPiBridge,
  handleChildrenOfPiBridgeRequest,
} from "../child-bridge.ts";
import { ChildBio, createChildIdentity } from "../child-bios.ts";

class FakeBus {
  handlers = new Map();

  emit(channel, data) {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel, handler) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.handlers.delete(channel);
    };
  }
}

function fixture() {
  const bus = new FakeBus();
  const identity = createChildIdentity("agent-3", "owner-session", () => "instance-live");
  const deadIdentity = createChildIdentity("agent-2", "owner-session", () => "instance-dead");
  const live = { ...identity, alive: true, bio: new ChildBio(() => "2026-07-30T01:02:03.000Z") };
  const dead = { ...deadIdentity, alive: false, bio: null };
  const children = [live, dead];
  const summaries = (child) => ({
    address: child.address,
    displayId: child.id,
    instanceId: child.instanceId,
    ownerSessionId: child.ownerSessionId,
    state: child.alive ? "idle" : "exited",
    bio: child.bio?.get() ?? null,
  });
  const changes = [];
  const options = {
    events: bus,
    getOwnerSessionId: () => "owner-session",
    listChildren: () => children,
    getChildByInstanceId: (instanceId) => children.find((child) => child.instanceId === instanceId),
    summarizeChild: summaries,
    onBioChanged: (child) => changes.push(child.instanceId),
  };
  return { bus, live, dead, children, changes, options };
}

const remoteParent = {
  kind: "parent",
  sessionId: "remote-parent-session",
  name: "Planner",
};

test("bridge list exposes only live children with stable addresses and implemented capabilities", () => {
  const { options, live } = fixture();
  const response = handleChildrenOfPiBridgeRequest({
    version: 1,
    requestId: "list-1",
    type: "children.list",
  }, options);

  assert.equal(response.success, true);
  assert.deepEqual(response.result.capabilities, [...CHILDREN_OF_PI_CAPABILITIES]);
  assert.equal(response.result.ownerSessionId, "owner-session");
  assert.deepEqual(response.result.children.map((child) => child.instanceId), [live.instanceId]);
  assert.deepEqual(Object.keys(response.result.children[0]).sort(), [
    "address", "bio", "displayId", "instanceId", "ownerSessionId", "state",
  ]);
  assert.equal(response.result.children[0].address, "child:owner-session:instance-live");
  assert.deepEqual(response.result.children[0].bio, {
    text: "", revision: 0, updatedAt: null, updatedBy: null, stale: false,
  });
});

test("child.get and bio.get resolve stable instance IDs rather than display IDs", () => {
  const { options } = fixture();
  const child = handleChildrenOfPiBridgeRequest({
    requestId: "child-1", type: "child.get", instanceId: "instance-live",
  }, options);
  assert.equal(child.success, true);
  assert.equal(child.result.displayId, "agent-3");

  const wrongAddress = handleChildrenOfPiBridgeRequest({
    requestId: "child-2", type: "child.get", instanceId: "agent-3",
  }, options);
  assert.equal(wrongAddress.success, false);
  assert.equal(wrongAddress.error.code, "child_unavailable");

  const bio = handleChildrenOfPiBridgeRequest({
    requestId: "bio-1", type: "bio.get", instanceId: "instance-live",
  }, options);
  assert.equal(bio.success, true);
  assert.equal(bio.result.address, "child:owner-session:instance-live");
  assert.equal(bio.result.bio.revision, 0);
});

test("remote child bio mutation records the authenticated remote parent and emits change", () => {
  const { options, live, changes } = fixture();
  const bridge = createChildrenOfPiBridge(options);
  const response = bridge.handleRequest({
    requestId: "set-1",
    type: "bio.set",
    instanceId: live.instanceId,
    bio: "Has inspected persistence and replay visibility.",
    expectedRevision: 0,
    actor: remoteParent,
    updatedBy: { kind: "parent", sessionId: "forged", name: "Forged" },
  }, options);

  assert.equal(response.success, true);
  assert.equal(response.result.bio.revision, 1);
  assert.deepEqual(response.result.bio.updatedBy, remoteParent);
  assert.deepEqual(live.bio.get().updatedBy, remoteParent);
  assert.deepEqual(changes, [live.instanceId]);
  bridge.dispose();
});

test("bridge bio CAS conflicts return the current record and force is explicit", () => {
  const { options, live } = fixture();
  assert.equal(handleChildrenOfPiBridgeRequest({
    requestId: "set-current", type: "bio.set", instanceId: live.instanceId,
    bio: "current", expectedRevision: 0, actor: remoteParent,
  }, options).success, true);

  const conflict = handleChildrenOfPiBridgeRequest({
    requestId: "set-stale", type: "bio.set", instanceId: live.instanceId,
    bio: "stale overwrite", expectedRevision: 0, actor: remoteParent,
  }, options);
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, "bio_revision_conflict");
  assert.equal(conflict.result.conflict, true);
  assert.equal(conflict.result.current.text, "current");
  assert.equal(conflict.result.current.revision, 1);
  assert.equal(live.bio.get().text, "current");

  const forced = handleChildrenOfPiBridgeRequest({
    requestId: "set-force", type: "bio.set", instanceId: live.instanceId,
    bio: "forced", force: true, actor: remoteParent,
  }, options);
  assert.equal(forced.success, true);
  assert.equal(forced.result.bio.text, "forced");
  assert.equal(forced.result.bio.revision, 2);
});

test("bridge clear uses CAS and external callers cannot claim system attribution", () => {
  const { options, live } = fixture();
  const system = handleChildrenOfPiBridgeRequest({
    requestId: "forged-system", type: "bio.clear", instanceId: live.instanceId,
    expectedRevision: 0,
    actor: { kind: "system", reason: "context-reset" },
  }, options);
  assert.equal(system.success, false);
  assert.equal(system.error.code, "invalid_request");
  assert.equal(live.bio.get().revision, 0);

  const cleared = handleChildrenOfPiBridgeRequest({
    requestId: "clear-1", type: "bio.clear", instanceId: live.instanceId,
    expectedRevision: 0,
    actor: { kind: "human", via: "whatspi" },
  }, options);
  assert.equal(cleared.success, true);
  assert.equal(cleared.result.bio.text, "");
  assert.equal(cleared.result.bio.revision, 1);
  assert.deepEqual(cleared.result.bio.updatedBy, { kind: "human", via: "whatspi" });
});

test("dead, unknown, and replaced child instance IDs fail safely", () => {
  const { options, live, children } = fixture();
  for (const instanceId of ["instance-dead", "missing-instance"]) {
    const response = handleChildrenOfPiBridgeRequest({
      requestId: `get-${instanceId}`, type: "bio.get", instanceId,
    }, options);
    assert.equal(response.success, false);
    assert.equal(response.error.code, "child_unavailable");
  }

  children.splice(children.indexOf(live), 1);
  const replaced = handleChildrenOfPiBridgeRequest({
    requestId: "old-instance", type: "child.get", instanceId: "instance-live",
  }, options);
  assert.equal(replaced.success, false);
  assert.equal(replaced.error.code, "child_unavailable");
});

test("change-notification failure cannot turn a committed bio edit into failure", () => {
  const { options, live } = fixture();
  options.onBioChanged = () => { throw new Error("listener failed"); };
  const bridge = createChildrenOfPiBridge(options);
  const response = bridge.handleRequest({
    requestId: "notify-failure", type: "bio.set", instanceId: live.instanceId,
    bio: "committed", expectedRevision: 0, actor: remoteParent,
  });
  assert.equal(response.success, true);
  assert.equal(live.bio.get().text, "committed");
  assert.equal(live.bio.get().revision, 1);
  bridge.dispose();
});

test("event-bus adapter deduplicates retries and rejects request-id payload changes", () => {
  const { options, bus, live, changes } = fixture();
  const bridge = createChildrenOfPiBridge(options);
  const responses = [];
  bus.on(childrenOfPiResponseChannel("mutation-1"), (value) => responses.push(value));
  const request = {
    requestId: "mutation-1", type: "bio.set", instanceId: live.instanceId,
    bio: "set exactly once", expectedRevision: 0, actor: remoteParent,
  };

  bus.emit(CHILDREN_OF_PI_REQUEST_CHANNEL, request);
  bus.emit(CHILDREN_OF_PI_REQUEST_CHANNEL, structuredClone(request));
  assert.equal(responses.length, 2);
  assert.deepEqual(responses[1], responses[0]);
  assert.equal(live.bio.get().revision, 1);
  assert.deepEqual(changes, [live.instanceId]);

  bus.emit(CHILDREN_OF_PI_REQUEST_CHANNEL, { ...request, bio: "different payload" });
  assert.equal(responses.length, 3);
  assert.equal(responses[2].success, false);
  assert.equal(responses[2].error.code, "duplicate_request");
  assert.equal(live.bio.get().text, "set exactly once");
  bridge.dispose();
});

test("event-bus adapter emits correlated responses and changed notifications, then disposes", () => {
  const { options, bus, live } = fixture();
  const bridge = createChildrenOfPiBridge(options);
  const responses = [];
  const changed = [];
  bus.on(childrenOfPiResponseChannel("request-7"), (value) => responses.push(value));
  bus.on(CHILDREN_OF_PI_CHANGED_CHANNEL, (value) => changed.push(value));

  bus.emit(CHILDREN_OF_PI_REQUEST_CHANNEL, {
    requestId: "request-7", type: "bio.get", instanceId: live.instanceId,
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].requestId, "request-7");
  assert.equal(responses[0].success, true);

  bridge.emitChanged("spawn", live);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].change, "spawn");
  assert.equal(changed[0].instanceId, live.instanceId);
  assert.equal(changed[0].ownerSessionId, "owner-session");

  live.alive = false;
  live.bio = null;
  bridge.emitChanged("exit", live);
  assert.equal(changed[1].change, "exit");
  assert.equal(changed[1].instanceId, live.instanceId);
  assert.equal("child" in changed[1], false);

  bridge.dispose();
  bus.emit(CHILDREN_OF_PI_REQUEST_CHANNEL, {
    requestId: "request-7", type: "bio.get", instanceId: live.instanceId,
  });
  assert.equal(responses.length, 1);
});

test("invalid versions and unsupported generic RPC requests are rejected", () => {
  const { options } = fixture();
  const version = handleChildrenOfPiBridgeRequest({
    version: 2, requestId: "version-2", type: "children.list",
  }, options);
  assert.equal(version.success, false);
  assert.equal(version.error.code, "incompatible_version");

  const rpc = handleChildrenOfPiBridgeRequest({
    requestId: "rpc-1", type: "child.rpc", instanceId: "instance-live",
  }, options);
  assert.equal(rpc.success, false);
  assert.equal(rpc.error.code, "unsupported_request");
  assert.equal(handleChildrenOfPiBridgeRequest({ type: "children.list" }, options), null);
});
