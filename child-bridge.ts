import {
  type AgentBio,
  type BioMutationResult,
  type ChildBio,
  parseExternalBioActor,
} from "./child-bios.ts";

export const CHILDREN_OF_PI_BRIDGE_VERSION = 1 as const;
export const CHILDREN_OF_PI_REQUEST_CHANNEL = "children-of-pi:request";
export const CHILDREN_OF_PI_RESPONSE_PREFIX = "children-of-pi:response:";
export const CHILDREN_OF_PI_CHANGED_CHANNEL = "children-of-pi:changed";
export const CHILDREN_OF_PI_CAPABILITIES = [
  "children.read",
  "children.bio.read",
  "children.bio.write",
] as const;

export type ChildrenOfPiCapability = typeof CHILDREN_OF_PI_CAPABILITIES[number];
export type ChildrenOfPiRequestType =
  | "children.list"
  | "child.get"
  | "bio.get"
  | "bio.set"
  | "bio.clear";
export type ChildChange = "spawn" | "exit" | "lifecycle" | "bio" | "context-reset";

type JsonObject = Record<string, unknown>;
const MAX_RECENT_BRIDGE_REQUESTS = 1_000;

export interface EventBusLike {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface BridgeChild {
  id: string;
  instanceId: string;
  ownerSessionId: string;
  ownerParentSessionId: string;
  address: string;
  alive: boolean;
  bio: ChildBio | null;
}

export interface ChildrenOfPiBridgeOptions {
  events: EventBusLike;
  getOwnerSessionId(): string | null;
  listChildren(): BridgeChild[];
  getChildByInstanceId(instanceId: string): BridgeChild | undefined;
  summarizeChild(child: BridgeChild): JsonObject;
  onBioChanged?(child: BridgeChild): void;
}

export interface ChildrenOfPiBridgeResponse {
  version: typeof CHILDREN_OF_PI_BRIDGE_VERSION;
  requestId: string;
  type: "response";
  requestType: string;
  success: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export interface ChildrenOfPiChangedEvent {
  version: typeof CHILDREN_OF_PI_BRIDGE_VERSION;
  type: "changed";
  change: ChildChange;
  ownerSessionId: string | null;
  capabilities: ChildrenOfPiCapability[];
  instanceId?: string;
  address?: string;
  child?: JsonObject;
}

class BridgeRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BridgeRequestError";
    this.code = code;
  }
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requestId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null;
  return value;
}

function stableFingerprint(value: unknown): string | null {
  const seen = new WeakSet<object>();
  const normalize = (item: unknown): unknown => {
    if (!item || typeof item !== "object") return item;
    if (seen.has(item)) throw new TypeError("Cyclic request.");
    seen.add(item);
    if (Array.isArray(item)) return item.map(normalize);
    return Object.fromEntries(Object.keys(item as JsonObject).sort().map((key) => [
      key,
      normalize((item as JsonObject)[key]),
    ]));
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return null;
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeRequestError("invalid_request", `${field} must be a non-empty string.`);
  }
  return value;
}

function parseExpectedRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BridgeRequestError("invalid_request", "expectedRevision must be a non-negative safe integer.");
  }
  return value as number;
}

function parseForce(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new BridgeRequestError("invalid_request", "force must be a boolean.");
  }
  return value;
}

function mutationResult(child: BridgeChild, mutation: BioMutationResult): JsonObject {
  const identity = {
    address: child.address,
    displayId: child.id,
    instanceId: child.instanceId,
    ownerSessionId: child.ownerSessionId,
  };
  if (mutation.success) return { ...identity, bio: mutation.bio };
  return {
    ...identity,
    conflict: true,
    expectedRevision: mutation.expectedRevision,
    current: mutation.current,
    bio: mutation.current,
  };
}

function bioResult(child: BridgeChild, bio: AgentBio): JsonObject {
  return {
    address: child.address,
    displayId: child.id,
    instanceId: child.instanceId,
    ownerSessionId: child.ownerSessionId,
    bio,
  };
}

function response(
  id: string,
  type: string,
  success: boolean,
  result?: unknown,
  error?: { code: string; message: string },
): ChildrenOfPiBridgeResponse {
  return {
    version: CHILDREN_OF_PI_BRIDGE_VERSION,
    requestId: id,
    type: "response",
    requestType: type,
    success,
    ...(result === undefined ? {} : { result }),
    ...(error === undefined ? {} : { error }),
  };
}

function requireLiveChild(options: ChildrenOfPiBridgeOptions, value: unknown): BridgeChild {
  const instanceId = requiredString(value, "instanceId");
  const child = options.getChildByInstanceId(instanceId);
  if (!child || !child.alive || !child.bio) {
    throw new BridgeRequestError(
      "child_unavailable",
      `No live child exists for instanceId ${instanceId}.`,
    );
  }
  return child;
}

/** Handle one bridge request without relying on event-bus timing; useful for tests and adapters. */
export function handleChildrenOfPiBridgeRequest(
  value: unknown,
  options: ChildrenOfPiBridgeOptions,
): ChildrenOfPiBridgeResponse | null {
  const request = object(value);
  const id = requestId(request?.requestId);
  if (!request || !id) return null;
  const typeValue = request.type ?? request.requestType;
  const type = typeof typeValue === "string" ? typeValue : "unknown";

  try {
    if (request.version !== undefined && request.version !== CHILDREN_OF_PI_BRIDGE_VERSION) {
      throw new BridgeRequestError(
        "incompatible_version",
        `Unsupported children-of-pi bridge version: ${String(request.version)}.`,
      );
    }

    if (type === "children.list") {
      const children = options.listChildren()
        .filter((child) => child.alive && child.bio !== null)
        .map((child) => options.summarizeChild(child));
      return response(id, type, true, {
        ownerSessionId: options.getOwnerSessionId(),
        capabilities: [...CHILDREN_OF_PI_CAPABILITIES],
        children,
      });
    }

    if (type === "child.get") {
      const child = requireLiveChild(options, request.instanceId);
      return response(id, type, true, options.summarizeChild(child));
    }

    if (type === "bio.get") {
      const child = requireLiveChild(options, request.instanceId);
      return response(id, type, true, bioResult(child, child.bio!.get()));
    }

    if (type === "bio.set" || type === "bio.clear") {
      const child = requireLiveChild(options, request.instanceId);
      const actor = parseExternalBioActor(request.actor);
      const expectedRevision = parseExpectedRevision(request.expectedRevision);
      const force = parseForce(request.force);
      if (type === "bio.set" && typeof request.bio !== "string") {
        throw new BridgeRequestError("invalid_request", "bio.set requires bio text.");
      }

      const mutation = type === "bio.set"
        ? child.bio!.set(request.bio, actor, { expectedRevision, force })
        : child.bio!.clear(actor, { expectedRevision, force });
      const result = mutationResult(child, mutation);
      if (!mutation.success) {
        return response(id, type, false, result, {
          code: "bio_revision_conflict",
          message: `Bio revision conflict: current revision is ${mutation.current.revision}.`,
        });
      }
      return response(id, type, true, result);
    }

    throw new BridgeRequestError("unsupported_request", `Unsupported children-of-pi request type: ${type}.`);
  } catch (error) {
    const parsed = error instanceof BridgeRequestError
      ? error
      : new BridgeRequestError("invalid_request", error instanceof Error ? error.message : String(error));
    return response(id, type, false, undefined, { code: parsed.code, message: parsed.message });
  }
}

export function childrenOfPiResponseChannel(id: string): string {
  return `${CHILDREN_OF_PI_RESPONSE_PREFIX}${requiredString(id, "requestId")}`;
}

export function createChildrenOfPiBridge(options: ChildrenOfPiBridgeOptions): {
  dispose(): void;
  emitChanged(change: ChildChange, child?: BridgeChild): void;
  handleRequest(value: unknown): ChildrenOfPiBridgeResponse | null;
} {
  const recent = new Map<string, {
    fingerprint: string | null;
    response: ChildrenOfPiBridgeResponse;
  }>();
  const publish = (result: ChildrenOfPiBridgeResponse) => {
    // Event-bus payloads are passed by reference. Publish a detached snapshot so
    // another extension cannot mutate the cached response used for retries.
    options.events.emit(childrenOfPiResponseChannel(result.requestId), structuredClone(result));
  };

  const handleRequest = (value: unknown) => {
    const request = object(value);
    const id = requestId(request?.requestId);
    const fingerprint = stableFingerprint(value);
    const previous = id ? recent.get(id) : undefined;
    if (id && previous) {
      const result = previous.fingerprint !== null && previous.fingerprint === fingerprint
        ? structuredClone(previous.response)
        : response(
          id,
          typeof (request?.type ?? request?.requestType) === "string"
            ? String(request?.type ?? request?.requestType)
            : "unknown",
          false,
          undefined,
          {
            code: "duplicate_request",
            message: `requestId ${id} was already used for a different bridge request.`,
          },
        );
      publish(result);
      return result;
    }

    const result = handleChildrenOfPiBridgeRequest(value, options);
    if (result) {
      if (recent.size >= MAX_RECENT_BRIDGE_REQUESTS) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
      recent.set(result.requestId, { fingerprint, response: structuredClone(result) });
      publish(result);

      const requestType = request?.type ?? request?.requestType;
      if (result.success && (requestType === "bio.set" || requestType === "bio.clear")) {
        const instanceId = request?.instanceId;
        const child = typeof instanceId === "string"
          ? options.getChildByInstanceId(instanceId)
          : undefined;
        if (child?.alive && child.bio) {
          // Response publication is authoritative. Change notification is
          // best-effort cache invalidation and cannot turn a committed edit into failure.
          try { options.onBioChanged?.(child); } catch { /* trusted listener failure */ }
        }
      }
    }
    return result;
  };

  const disposeListener = options.events.on(CHILDREN_OF_PI_REQUEST_CHANNEL, handleRequest);
  const dispose = () => {
    disposeListener();
    recent.clear();
  };
  return {
    dispose,
    handleRequest,
    emitChanged(change, child) {
      const event: ChildrenOfPiChangedEvent = {
        version: CHILDREN_OF_PI_BRIDGE_VERSION,
        type: "changed",
        change,
        ownerSessionId: options.getOwnerSessionId(),
        capabilities: [...CHILDREN_OF_PI_CAPABILITIES],
        ...(child ? {
          instanceId: child.instanceId,
          address: child.address,
          ...(child.alive && child.bio ? { child: options.summarizeChild(child) } : {}),
        } : {}),
      };
      options.events.emit(CHILDREN_OF_PI_CHANGED_CHANNEL, event);
    },
  };
}
