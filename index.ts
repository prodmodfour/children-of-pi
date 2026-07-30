import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type JsonObject = Record<string, unknown>;

type WaitMode = "none" | "event" | "settled";

interface StoredEvent {
  sequence: number;
  event: JsonObject;
}

interface PendingRequest {
  resolve: (response: JsonObject) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface EventWaiter {
  after: number;
  predicate: (item: StoredEvent) => boolean;
  resolve: (item: StoredEvent | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface ChildAgent {
  id: string;
  process: ChildProcessWithoutNullStreams;
  cwd: string;
  write: boolean;
  createdAt: string;
  alive: boolean;
  isStreaming: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  stderr: string;
  lastAssistantText: string | null;
  lastState: JsonObject | null;
  nextSequence: number;
  readCursor: number;
  events: StoredEvent[];
  pending: Map<string, PendingRequest>;
  waiters: Set<EventWaiter>;
  closed: Promise<void>;
  resolveClosed: () => void;
}

const READ_ONLY_TOOLS = "read,grep,find,ls";
const MAX_STORED_EVENTS = 2_000;
const MAX_STDERR_BYTES = 50 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`RPC command requires a non-empty ${field} string.`);
  }
  return value;
}

function keepTailByBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value.slice(-maxBytes);
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
  return result;
}

function renderJson(value: unknown, metadata: JsonObject = {}) {
  const json = JSON.stringify(value, null, 2) ?? "null";
  const truncated = truncateHead(json, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });

  let text = truncated.content;
  if (truncated.truncated) {
    text += `\n\n[Output truncated to ${DEFAULT_MAX_BYTES} bytes / ${DEFAULT_MAX_LINES} lines. Use RPC cursors or narrower queries for the rest.]`;
  }

  return {
    content: [{ type: "text" as const, text }],
    details: { ...metadata, truncated: truncated.truncated },
  };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");

  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = process.execPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function shouldStoreEvent(event: JsonObject): boolean {
  // Complete messages/results arrive in later events. Keeping every cumulative
  // streaming update would grow quadratically while adding no durable state.
  return ![
    "message_update",
    "tool_execution_update",
    "bash_execution_update",
  ].includes(String(event.type));
}

function assistantText(message: unknown): string | null {
  if (!isJsonObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }

  const parts = message.content
    .filter((part): part is JsonObject => isJsonObject(part) && part.type === "text")
    .map((part) => part.text)
    .filter((text): text is string => typeof text === "string");

  return parts.length > 0 ? parts.join("\n") : null;
}

function cleanupWaiter(child: ChildAgent, waiter: EventWaiter): void {
  child.waiters.delete(waiter);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener("abort", waiter.abortHandler);
  }
}

function appendEvent(child: ChildAgent, event: JsonObject): void {
  const type = String(event.type ?? "");
  if (type === "agent_start") child.isStreaming = true;
  if (type === "agent_settled") child.isStreaming = false;

  if (type === "message_end") {
    const text = assistantText(event.message);
    if (text !== null) child.lastAssistantText = text;
  }

  if (!shouldStoreEvent(event)) return;

  const item: StoredEvent = {
    sequence: ++child.nextSequence,
    event,
  };
  child.events.push(item);
  if (child.events.length > MAX_STORED_EVENTS) child.events.shift();

  for (const waiter of [...child.waiters]) {
    if (item.sequence > waiter.after && waiter.predicate(item)) {
      cleanupWaiter(child, waiter);
      waiter.resolve(item);
    }
  }
}

function rejectPending(child: ChildAgent, error: Error): void {
  for (const pending of child.pending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  child.pending.clear();
}

function attachJsonlReader(child: ChildAgent): void {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) return;

    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      appendEvent(child, {
        type: "protocol_parse_error",
        line: line.slice(0, 2_000),
      });
      return;
    }

    if (!isJsonObject(value)) return;

    if (value.type === "response" && typeof value.id === "string") {
      const pending = child.pending.get(value.id);
      if (pending) {
        child.pending.delete(value.id);
        clearTimeout(pending.timer);

        if (value.command === "get_state" && value.success === true && isJsonObject(value.data)) {
          child.lastState = value.data;
          child.isStreaming = value.data.isStreaming === true;
        }
        if (
          value.command === "get_last_assistant_text"
          && value.success === true
          && isJsonObject(value.data)
          && (typeof value.data.text === "string" || value.data.text === null)
        ) {
          child.lastAssistantText = value.data.text as string | null;
        }

        pending.resolve(value);
        return;
      }
    }

    appendEvent(child, value);
  };

  child.process.stdout.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      processLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });

  child.process.stdout.on("end", () => {
    buffer += decoder.end();
    if (buffer) processLine(buffer);
    buffer = "";
  });
}

async function writeJsonLine(child: ChildAgent, command: JsonObject): Promise<void> {
  if (!child.alive || child.process.exitCode !== null) {
    throw new Error(`Subagent ${child.id} is not running.`);
  }
  if (child.process.stdin.destroyed || !child.process.stdin.writable) {
    throw new Error(`Subagent ${child.id} stdin is not writable.`);
  }

  return new Promise((resolveWrite, rejectWrite) => {
    child.process.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

let requestNumber = 0;

async function sendRpc(
  child: ChildAgent,
  command: JsonObject,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<JsonObject> {
  const commandType = asString(command.type, "type");

  // Extension UI responses are acknowledgements to a child-originated request,
  // not ordinary RPC commands and do not receive a command response.
  if (commandType === "extension_ui_response") {
    asString(command.id, "id");
    await writeJsonLine(child, command);
    return { type: "sent", command: commandType, success: true };
  }

  const id = `subagent_${child.id}_${++requestNumber}`;
  const payload = { ...command, id };

  if (["prompt", "steer", "follow_up"].includes(commandType)) {
    child.isStreaming = true;
  }

  return new Promise<JsonObject>((resolveResponse, rejectResponse) => {
    let abortHandler: (() => void) | undefined;
    const timer = setTimeout(() => {
      child.pending.delete(id);
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      rejectResponse(new Error(`Timed out waiting for ${commandType} response from ${child.id}.`));
    }, timeoutMs);

    const pending: PendingRequest = {
      timer,
      resolve: (response) => {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        resolveResponse(response);
      },
      reject: (error) => {
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
        rejectResponse(error);
      },
    };
    child.pending.set(id, pending);

    if (signal) {
      abortHandler = () => {
        const current = child.pending.get(id);
        if (!current) return;
        child.pending.delete(id);
        clearTimeout(current.timer);
        rejectResponse(new Error(`RPC request to ${child.id} was cancelled.`));
      };
      if (signal.aborted) {
        abortHandler();
        return;
      }
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    writeJsonLine(child, payload).catch((error: unknown) => {
      const current = child.pending.get(id);
      if (!current) return;
      child.pending.delete(id);
      clearTimeout(current.timer);
      current.reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function waitForEvent(
  child: ChildAgent,
  after: number,
  predicate: (item: StoredEvent) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StoredEvent | undefined> {
  const existing = child.events.find((item) => item.sequence > after && predicate(item));
  if (existing) return Promise.resolve(existing);
  if (!child.alive) return Promise.resolve(undefined);

  return new Promise((resolveWait, rejectWait) => {
    const waiter: EventWaiter = {
      after,
      predicate,
      resolve: resolveWait,
      signal,
    };

    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        cleanupWaiter(child, waiter);
        resolveWait(undefined);
      }, timeoutMs);
    }

    if (signal) {
      waiter.abortHandler = () => {
        cleanupWaiter(child, waiter);
        rejectWait(new Error(`Waiting for ${child.id} was cancelled.`));
      };
      if (signal.aborted) {
        waiter.abortHandler();
        return;
      }
      signal.addEventListener("abort", waiter.abortHandler, { once: true });
    }

    child.waiters.add(waiter);
  });
}

async function stopChild(child: ChildAgent): Promise<void> {
  if (!child.alive) return;
  child.process.kill("SIGTERM");

  await Promise.race([
    child.closed,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);

  if (child.alive) {
    child.process.kill("SIGKILL");
    await Promise.race([
      child.closed,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
    ]);
  }
}

function childSummary(child: ChildAgent): JsonObject {
  return {
    id: child.id,
    pid: child.process.pid ?? null,
    cwd: child.cwd,
    write: child.write,
    alive: child.alive,
    isStreaming: child.isStreaming,
    createdAt: child.createdAt,
    exitCode: child.exitCode,
    exitSignal: child.exitSignal,
    lastEventSequence: child.nextSequence,
    lastAssistantText: child.lastAssistantText,
    state: child.lastState === null
      ? null
      : { ...child.lastState, isStreaming: child.isStreaming },
    stderr: child.stderr || undefined,
  };
}

const SpawnParameters = Type.Object({
  task: Type.Optional(Type.String({ description: "Initial task. Omit to start an idle child." })),
  write: Type.Boolean({
    description: "Whether the child may write. false gives read/grep/find/ls only; true gives normal Pi tools.",
  }),
  cwd: Type.Optional(Type.String({ description: "Child working directory. Defaults to the parent's cwd." })),
});

const RpcParameters = Type.Object({
  id: Type.String({ description: "Child id returned by subagent_spawn." }),
  command: Type.Any({
    description: [
      "A Pi RPC command object. Common types: prompt, steer, follow_up, abort, get_state, get_messages,",
      "get_entries, get_last_assistant_text, get_session_stats, set_model, set_thinking_level, compact, new_session.",
      "For extension_ui_response, preserve the request id from the child event.",
    ].join(" "),
  }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Command response timeout." })),
});

const EventsParameters = Type.Object({
  id: Type.String({ description: "Child id returned by subagent_spawn." }),
  after: Type.Optional(Type.Integer({ minimum: 0, description: "Sequence cursor. Omit to continue from the last read." })),
  wait: Type.Optional(StringEnum(["none", "event", "settled"] as const, {
    description: "Optionally wait for any new event or until the child settles.",
    default: "none",
  })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 0, description: "Wait timeout in milliseconds." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Maximum events returned." })),
});

const IdParameters = Type.Object({
  id: Type.String({ description: "Child id returned by subagent_spawn." }),
});

export default function rpcSubagents(pi: ExtensionAPI): void {
  const children = new Map<string, ChildAgent>();
  let childNumber = 0;

  const getChild = (id: string): ChildAgent => {
    const child = children.get(id);
    if (!child) throw new Error(`Unknown subagent: ${id}`);
    return child;
  };

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: "Start a persistent child Pi in RPC mode. The child runs independently until killed and may be read-only or writable.",
    parameters: SpawnParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        throw new Error(`Subagent cwd is not a directory: ${cwd}`);
      }

      const id = `agent-${++childNumber}`;
      const args = ["--mode", "rpc", "--no-session"];
      if (ctx.model) {
        args.push("--provider", ctx.model.provider, "--model", ctx.model.id);
      }
      if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
      if (!params.write) args.push("--tools", READ_ONLY_TOOLS);
      if (ctx.isProjectTrusted()) args.push("--approve");

      const invocation = getPiInvocation(args);
      const processHandle = spawn(invocation.command, invocation.args, {
        cwd,
        env: { ...process.env, PI_RPC_SUBAGENT: "1" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolvePromise) => {
        resolveClosed = resolvePromise;
      });

      const child: ChildAgent = {
        id,
        process: processHandle,
        cwd,
        write: params.write,
        createdAt: new Date().toISOString(),
        alive: true,
        isStreaming: false,
        exitCode: null,
        exitSignal: null,
        stderr: "",
        lastAssistantText: null,
        lastState: null,
        nextSequence: 0,
        readCursor: 0,
        events: [],
        pending: new Map(),
        waiters: new Set(),
        closed,
        resolveClosed,
      };
      children.set(id, child);
      attachJsonlReader(child);

      processHandle.stderr.on("data", (chunk: Buffer | string) => {
        child.stderr = keepTailByBytes(child.stderr + chunk.toString(), MAX_STDERR_BYTES);
      });

      processHandle.once("error", (error) => {
        appendEvent(child, { type: "process_error", error: error.message });
        rejectPending(child, error);
      });

      processHandle.once("close", (code, exitSignal) => {
        child.alive = false;
        child.isStreaming = false;
        child.exitCode = code;
        child.exitSignal = exitSignal;
        appendEvent(child, {
          type: "process_exit",
          code,
          signal: exitSignal,
          stderr: child.stderr || undefined,
        });
        rejectPending(child, new Error(`Subagent ${id} exited (code=${code}, signal=${exitSignal}).`));
        for (const waiter of [...child.waiters]) {
          cleanupWaiter(child, waiter);
          waiter.resolve(undefined);
        }
        child.resolveClosed();
      });

      const abortSpawn = () => void stopChild(child);
      if (signal) {
        if (signal.aborted) abortSpawn();
        else signal.addEventListener("abort", abortSpawn, { once: true });
      }

      try {
        onUpdate?.({
          content: [{ type: "text", text: `Starting ${id}...` }],
          details: { id, cwd, write: params.write },
        });

        const stateResponse = await sendRpc(child, { type: "get_state" }, DEFAULT_RPC_TIMEOUT_MS, signal);
        if (stateResponse.success !== true) {
          throw new Error(String(stateResponse.error ?? `Could not initialize ${id}.`));
        }

        let promptResponse: JsonObject | null = null;
        if (params.task) {
          promptResponse = await sendRpc(
            child,
            { type: "prompt", message: params.task },
            DEFAULT_RPC_TIMEOUT_MS,
            signal,
          );
          if (promptResponse.success !== true) {
            throw new Error(String(promptResponse.error ?? `Could not prompt ${id}.`));
          }
        }

        return renderJson({
          ...childSummary(child),
          promptAccepted: promptResponse !== null,
        }, { id });
      } catch (error) {
        await stopChild(child);
        throw error;
      } finally {
        if (signal) signal.removeEventListener("abort", abortSpawn);
      }
    },
  });

  pi.registerTool({
    name: "subagent_rpc",
    label: "Subagent RPC",
    description: "Send any supported Pi RPC command to a child and receive its structured response. Prompts return when accepted; the child continues independently.",
    parameters: RpcParameters,
    async execute(_toolCallId, params, signal) {
      const child = getChild(params.id);
      if (!isJsonObject(params.command)) throw new Error("command must be a JSON object.");
      const response = await sendRpc(child, params.command, params.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS, signal);
      return renderJson({ id: child.id, response }, { id: child.id });
    },
  });

  pi.registerTool({
    name: "subagent_events",
    label: "Subagent Events",
    description: "Read a child's structured RPC events, optionally waiting for activity or settlement. Delta events are coalesced; complete messages and tool results remain available.",
    parameters: EventsParameters,
    async execute(_toolCallId, params, signal) {
      const child = getChild(params.id);
      const after = params.after ?? child.readCursor;
      const wait = (params.wait ?? "none") as WaitMode;
      const timeoutMs = params.timeoutMs ?? (wait === "none" ? 0 : DEFAULT_WAIT_TIMEOUT_MS);

      const matching = () => child.events.filter((item) => item.sequence > after);
      const isSettlement = (item: StoredEvent) =>
        ["agent_settled", "process_exit"].includes(String(item.event.type));

      if (wait === "event" && matching().length === 0) {
        await waitForEvent(child, after, () => true, timeoutMs, signal);
      } else if (wait === "settled" && child.isStreaming && !matching().some(isSettlement)) {
        await waitForEvent(child, after, isSettlement, timeoutMs, signal);
      }

      const available = matching();
      const limit = params.limit ?? 100;
      const returned = available.slice(0, limit);
      if (returned.length > 0) {
        child.readCursor = returned[returned.length - 1].sequence;
      }

      const oldestSequence = child.events[0]?.sequence ?? child.nextSequence + 1;
      return renderJson({
        id: child.id,
        alive: child.alive,
        isStreaming: child.isStreaming,
        after,
        oldestSequence,
        nextSequence: returned.at(-1)?.sequence ?? after,
        latestSequence: child.nextSequence,
        hasMore: available.length > returned.length,
        events: returned,
        lastAssistantText: child.lastAssistantText,
        stderr: child.stderr || undefined,
      }, { id: child.id, nextSequence: returned.at(-1)?.sequence ?? after });
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: "List all child Pi agents owned by this parent session and their current lifecycle state.",
    parameters: Type.Object({}),
    async execute() {
      return renderJson({ children: [...children.values()].map(childSummary) });
    },
  });

  pi.registerTool({
    name: "subagent_kill",
    label: "Kill Subagent",
    description: "Terminate a child Pi process. Use the RPC abort command instead when you want to stop only its current operation and retain its context.",
    parameters: IdParameters,
    async execute(_toolCallId, params) {
      const child = getChild(params.id);
      await stopChild(child);
      return renderJson(childSummary(child), { id: child.id });
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...children.values()].map((child) => stopChild(child)));
    children.clear();
  });
}
