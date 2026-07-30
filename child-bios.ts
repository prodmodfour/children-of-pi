import { randomUUID } from "node:crypto";

export const MAX_BIO_CODEPOINTS = 2_000;
export const MAX_CHILD_BIO_HISTORY = 100;

export type BioActor =
  | {
      kind: "human";
      via: "pi-tui" | "whatspi";
      parentSessionId?: string;
    }
  | {
      kind: "parent";
      sessionId: string;
      name: string | null;
    }
  | {
      kind: "system";
      reason: "context-reset" | "branch-change";
    };

export type ExternalBioActor = Exclude<BioActor, { kind: "system" }>;

export interface AgentBio {
  text: string;
  revision: number;
  updatedAt: string | null;
  updatedBy: BioActor | null;
  stale: boolean;
}

export interface BioAuditEntry extends AgentBio {}

export interface ChildIdentity {
  id: string;
  instanceId: string;
  ownerSessionId: string;
  ownerParentSessionId: string;
  address: string;
}

export type BioMutationResult =
  | { success: true; bio: AgentBio }
  | {
      success: false;
      conflict: true;
      expectedRevision: number | null;
      current: AgentBio;
    };

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

function cloneActor(actor: BioActor | null): BioActor | null {
  if (actor === null) return null;
  if (actor.kind === "human") {
    return actor.parentSessionId === undefined
      ? { kind: "human", via: actor.via }
      : { kind: "human", via: actor.via, parentSessionId: actor.parentSessionId };
  }
  if (actor.kind === "parent") {
    return { kind: "parent", sessionId: actor.sessionId, name: actor.name };
  }
  return { kind: "system", reason: actor.reason };
}

export function cloneBio(bio: AgentBio): AgentBio {
  return { ...bio, updatedBy: cloneActor(bio.updatedBy) };
}

export function createAgentBio(): AgentBio {
  return {
    text: "",
    revision: 0,
    updatedAt: null,
    updatedBy: null,
    stale: false,
  };
}

/** Normalize CRLF only; preserve all other intentional Markdown and whitespace. */
export function normalizeBioText(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Bio text must be a string.");
  const text = value.replace(/\r\n/g, "\n");
  if (Array.from(text).length > MAX_BIO_CODEPOINTS) {
    throw new RangeError(`Bio text must be at most ${MAX_BIO_CODEPOINTS} Unicode code points.`);
  }
  return text;
}

/** Validate actors accepted from the trusted process-local pi-panda bridge. */
export function parseExternalBioActor(value: unknown): ExternalBioActor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Authenticated bio actor is required.");
  }

  const actor = value as Record<string, unknown>;
  if (actor.kind === "parent") {
    return {
      kind: "parent",
      sessionId: nonEmpty(actor.sessionId, "actor.sessionId"),
      name: actor.name === null ? null : nonEmpty(actor.name, "actor.name"),
    };
  }

  if (actor.kind === "human" && (actor.via === "pi-tui" || actor.via === "whatspi")) {
    const parsed: ExternalBioActor = { kind: "human", via: actor.via };
    if (actor.parentSessionId !== undefined) {
      parsed.parentSessionId = nonEmpty(actor.parentSessionId, "actor.parentSessionId");
    }
    return parsed;
  }

  throw new TypeError("Authenticated bio actor must be a parent or human actor.");
}

function validateExpectedRevision(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError("expectedRevision must be a non-negative safe integer.");
  }
}

export function formatChildAddress(ownerSessionId: string, instanceId: string): string {
  return `child:${nonEmpty(ownerSessionId, "ownerSessionId")}:${nonEmpty(instanceId, "instanceId")}`;
}

export function createChildIdentity(
  id: string,
  ownerSessionId: string,
  createInstanceId: () => string = randomUUID,
): ChildIdentity {
  const parsedId = nonEmpty(id, "id");
  const parsedOwnerSessionId = nonEmpty(ownerSessionId, "ownerSessionId");
  const instanceId = nonEmpty(createInstanceId(), "instanceId");
  return {
    id: parsedId,
    instanceId,
    ownerSessionId: parsedOwnerSessionId,
    ownerParentSessionId: parsedOwnerSessionId,
    address: formatChildAddress(parsedOwnerSessionId, instanceId),
  };
}

/** In-memory bio state owned by one live child process instance. */
export class ChildBio {
  #bio: AgentBio = createAgentBio();
  #history: BioAuditEntry[] = [];
  private readonly now: () => string;
  private readonly historyLimit: number;

  constructor(
    now: () => string = () => new Date().toISOString(),
    historyLimit = MAX_CHILD_BIO_HISTORY,
  ) {
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
      throw new RangeError("historyLimit must be a positive safe integer.");
    }
    this.now = now;
    this.historyLimit = historyLimit;
  }

  get(): AgentBio {
    return cloneBio(this.#bio);
  }

  history(): BioAuditEntry[] {
    return this.#history.map(cloneBio);
  }

  set(
    text: unknown,
    actor: ExternalBioActor,
    options: { expectedRevision?: number; force?: boolean } = {},
  ): BioMutationResult {
    validateExpectedRevision(options.expectedRevision);
    if (options.force !== true && options.expectedRevision !== this.#bio.revision) {
      return {
        success: false,
        conflict: true,
        expectedRevision: options.expectedRevision ?? null,
        current: this.get(),
      };
    }
    return this.#replace(normalizeBioText(text), actor);
  }

  clear(
    actor: ExternalBioActor,
    options: { expectedRevision?: number; force?: boolean } = {},
  ): BioMutationResult {
    return this.set("", actor, options);
  }

  /** A successful full-context replacement always records a new blank revision. */
  resetContext(): AgentBio {
    return this.#replace("", { kind: "system", reason: "context-reset" }).bio;
  }

  #replace(text: string, actor: BioActor): { success: true; bio: AgentBio } {
    this.#bio = {
      text,
      revision: this.#bio.revision + 1,
      updatedAt: this.now(),
      updatedBy: cloneActor(actor),
      stale: false,
    };
    this.#history.push(this.get());
    if (this.#history.length > this.historyLimit) {
      this.#history.splice(0, this.#history.length - this.historyLimit);
    }
    return { success: true, bio: this.get() };
  }
}
