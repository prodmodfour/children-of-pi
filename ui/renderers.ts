import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  accessMarker, formatBioActor, formatCost, formatTokens, isNonBlankBio, preview, shortenHome,
} from "./format.ts";
import { extractResultText, parseJsonResult, summarizeEvents, type JsonObject, type TextResultLike } from "./parse-result.ts";
import type { ChildCategory } from "./status.ts";

const object = (value: unknown): JsonObject | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
const string = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const number = (value: unknown): number | null => typeof value === "number" ? value : null;
const rawText = (result: TextResultLike) => new Text(extractResultText(result) || "(no text output)", 0, 0);
const mode = (write: unknown, theme: any) => write === true ? theme.fg("warning", "RW") : theme.fg("accent", "RO");

function icon(status: string, theme: any): string {
  if (status === "running") return theme.fg("accent", "●");
  if (status === "idle") return theme.fg("muted", "○");
  if (status === "failed") return theme.fg("error", "✗");
  if (status === "aborted") return theme.fg("warning", "◐");
  if (status === "exited" || status === "killed") return theme.fg("muted", "■");
  return theme.fg("success", "✓");
}

function expandedRaw(container: Container, raw: string, theme: any): void {
  if (!raw) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", "── Raw result ──"), 0, 0));
  container.addChild(new Text(theme.fg("toolOutput", raw), 0, 0));
}

function bioRecord(value: unknown): JsonObject | null {
  const bio = object(value);
  return bio && typeof bio.text === "string" && typeof bio.revision === "number" ? bio : null;
}

function addExpandedBio(container: Container, value: unknown, theme: any, title = "Bio"): void {
  const bio = bioRecord(value);
  if (!bio) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", title), 0, 0));
  if (isNonBlankBio(bio)) {
    container.addChild(new Markdown(string(bio.text), 0, 0, getMarkdownTheme()));
  } else {
    container.addChild(new Text(theme.fg("dim", "(blank)"), 0, 0));
  }
  const freshness = bio.stale === true ? theme.fg("warning", "stale") : theme.fg("success", "fresh");
  container.addChild(new Text(`${theme.fg("dim", `Revision ${String(bio.revision)} · `)}${freshness}`, 0, 0));
  container.addChild(new Text(theme.fg("dim", `Updated by: ${formatBioActor(bio.updatedBy)}`), 0, 0));
  container.addChild(new Text(theme.fg("dim", `Updated at: ${typeof bio.updatedAt === "string" ? bio.updatedAt : "never"}`), 0, 0));
}

export function renderSpawnCall(args: any, theme: any): Text {
  let text = `${theme.fg("toolTitle", theme.bold("Spawn subagent"))} · ${mode(args?.write, theme)}`;
  if (args?.task) text += `\n  ${theme.fg("toolOutput", preview(args.task, 80))}`;
  if (args?.cwd) text += `\n  ${theme.fg("dim", shortenHome(args.cwd))}`;
  return new Text(text, 0, 0);
}

export function renderSpawnResult(result: TextResultLike, options: any, theme: any): Text | Container {
  const { raw, value } = parseJsonResult(result);
  if (!value) {
    const partial = object(result.details);
    const partialId = partial?.id;
    if (options.isPartial && typeof partialId === "string") {
      return new Text(`${theme.fg("accent", "●")} ${theme.fg("toolTitle", partialId)} starting · ${mode(partial?.write, theme)}`, 0, 0);
    }
    return rawText(result);
  }
  const id = string(value.id, "subagent");
  const status = value.alive === false ? "exited" : "settled";
  let text = `${icon(status, theme)} ${theme.fg("toolTitle", theme.bold(id))} ${status === "exited" ? "exited" : "started"} · ${mode(value.write, theme)}`;
  if (typeof value.pid === "number") text += theme.fg("dim", ` · pid ${value.pid}`);
  if (value.promptAccepted === true) text += `\n  ${theme.fg("success", "task accepted")}`;
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container();
  container.addChild(new Text(text, 0, 0));
  if (typeof value.cwd === "string") container.addChild(new Text(theme.fg("dim", `cwd ${shortenHome(value.cwd)}`), 0, 0));
  expandedRaw(container, raw, theme);
  return container;
}

export function renderRpcCall(args: any, theme: any): Text {
  const command = object(args?.command);
  const type = string(command?.type, "rpc");
  let text = `${theme.fg("accent", "↳")} ${theme.fg("toolTitle", theme.bold(string(args?.id, "subagent")))} · ${theme.fg("accent", type)}`;
  if (typeof command?.message === "string") text += `\n  ${theme.fg("dim", preview(command.message, 90))}`;
  return new Text(text, 0, 0);
}

export function renderRpcResult(result: TextResultLike, options: any, theme: any): Text | Container {
  const { raw, value } = parseJsonResult(result);
  if (!value) return rawText(result);
  const response = object(value.response);
  const success = response?.success === true;
  const command = string(response?.command, "rpc");
  const accepted = ["prompt", "steer", "follow_up"].includes(command);
  const text = `${success ? icon("settled", theme) : icon("failed", theme)} ${theme.fg("toolTitle", string(value.id, "subagent"))} · ${command} ${success ? accepted ? "accepted" : "succeeded" : "failed"}`;
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container(); container.addChild(new Text(text, 0, 0)); expandedRaw(container, raw, theme); return container;
}

export function renderBioCall(args: any, theme: any): Text {
  const action = string(args?.action, "get");
  let text = `${theme.fg("toolTitle", theme.bold(`${string(args?.id, "subagent")} bio`))}${theme.fg("dim", ` · ${action}`)}`;
  if (action === "set" && typeof args?.bio === "string" && args.bio.length > 0) {
    text += `\n  ${theme.fg("toolOutput", preview(args.bio, 90))}`;
  }
  if (args?.force === true) text += `\n  ${theme.fg("warning", "force overwrite")}`;
  else if (typeof args?.expectedRevision === "number") {
    text += theme.fg("dim", ` · expected r${args.expectedRevision}`);
  }
  return new Text(text, 0, 0);
}

export function renderBioResult(result: TextResultLike, options: any, theme: any): Text | Container {
  const parsed = parseJsonResult(result);
  const raw = parsed.raw;
  const value = parsed.value ?? object(result.details);
  if (!value) return rawText(result);
  const action = string(value.action, "get");
  const bio = bioRecord(value.bio ?? value.current);
  const conflict = value.conflict === true || value.success === false;
  const status = conflict ? theme.fg("warning", "conflict") : action === "get" ? "read" : "saved";
  let text = `${conflict ? icon("aborted", theme) : icon("settled", theme)} ${theme.fg("toolTitle", string(value.id, "subagent"))} bio ${status}`;
  if (bio) text += theme.fg("dim", ` · r${String(bio.revision)}`);
  if (!options.expanded && bio && isNonBlankBio(bio)) {
    text += `\n  ${theme.fg("toolOutput", preview(bio.text, 100))}`;
  }
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container();
  container.addChild(new Text(text, 0, 0));
  addExpandedBio(container, bio, theme);
  if (typeof value.address === "string") {
    container.addChild(new Text(theme.fg("dim", `Address: ${value.address}`), 0, 0));
  }
  expandedRaw(container, raw, theme);
  return container;
}

export function renderEventsCall(args: any, theme: any): Text {
  const parts = [`${string(args?.id, "subagent")} events`, `wait=${string(args?.wait, "none")}`];
  if (typeof args?.after === "number") parts.push(`after #${args.after}`);
  return new Text(theme.fg("toolTitle", theme.bold(parts[0])) + theme.fg("dim", ` · ${parts.slice(1).join(" · ")}`), 0, 0);
}

function eventTimeline(value: JsonObject, theme: any): string {
  if (!Array.isArray(value.events)) return "";
  return value.events.map((item) => {
    const stored = object(item); const event = object(stored?.event); const sequence = number(stored?.sequence);
    const prefix = sequence === null ? "#?" : `#${sequence}`;
    const type = string(event?.type, "event");
    if (type === "tool_execution_start") return `${prefix}  → ${string(event?.toolName, "tool")}  ${preview(object(event?.args)?.path ?? object(event?.args)?.pattern ?? "", 50)}`.trimEnd();
    if (type === "tool_execution_end") return `${prefix}  ← ${string(event?.toolName, "tool")} ${event?.isError === true ? "failed" : "completed"}`;
    if (type === "message_end") return `${prefix}  ◆ ${string(object(event?.message)?.role, "message")} message`;
    if (type === "agent_settled") return `${prefix}  ✓ settled`;
    if (type === "process_exit") return `${prefix}  ■ process exit`;
    if (type.includes("error")) return `${prefix}  ✗ ${type}`;
    return `${prefix}  ${type}`;
  }).map((line) => theme.fg("toolOutput", line)).join("\n");
}

export function renderEventsResult(result: TextResultLike, options: any, theme: any, authoritativeStatus?: ChildCategory): Text | Container {
  const { raw, value } = parseJsonResult(result); if (!value) return rawText(result);
  const summary = summarizeEvents(value); const running = value.alive !== false && value.isStreaming === true;
  const status = authoritativeStatus ?? (value.alive === false ? "exited" : running ? "running" : "settled");
  const range = summary.count === 0 ? "no events" : summary.firstSequence === summary.lastSequence ? `#${summary.lastSequence}` : `#${summary.firstSequence}–#${summary.lastSequence}`;
  let text = `${icon(status, theme)} ${theme.fg("toolTitle", string(value.id, "subagent"))} ${status} · ${summary.count} events · ${range}`;
  const categories = [];
  if (summary.tools) categories.push(`${summary.tools} tools`);
  if (summary.messages) categories.push(`${summary.messages} messages`);
  if (summary.settlements) categories.push(`${summary.settlements} settlement`);
  if (summary.exits) categories.push(`${summary.exits} exit`);
  if (summary.protocolErrors) categories.push(`${summary.protocolErrors} errors`);
  if (summary.hasMore) categories.push("more available");
  if (value.cursorExpired === true) categories.push(`cursor expired${typeof value.eventsDropped === "number" ? ` · ${value.eventsDropped} dropped` : ""}`);
  if (categories.length) text += `\n  ${theme.fg("dim", categories.join(" · "))}`;
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container(); container.addChild(new Text(text, 0, 0));
  const timeline = eventTimeline(value, theme); if (timeline) { container.addChild(new Spacer(1)); container.addChild(new Text(timeline, 0, 0)); }
  expandedRaw(container, raw, theme); return container;
}

export function renderResultCall(args: any, theme: any): Text {
  return new Text(`${theme.fg("toolTitle", theme.bold(`${string(args?.id, "subagent")} result`))}${args?.wait === false ? "" : theme.fg("dim", " · waiting")}`, 0, 0);
}

export function renderResultResult(result: TextResultLike, options: any, theme: any): Text | Container {
  const { raw, value } = parseJsonResult(result); if (!value) return rawText(result);
  const status = string(value.status, "settled"); const usage = object(value.sessionUsage); const files = Array.isArray(value.sessionChangedFiles) ? value.sessionChangedFiles : [];
  const stats = [formatTokens(usage?.totalTokens), formatCost(usage?.cost), files.length ? `${files.length} files` : null].filter(Boolean).join(" · ");
  let text = `${icon(status, theme)} ${theme.fg("toolTitle", theme.bold(string(value.id, "subagent")))} ${status}${stats ? ` · ${theme.fg("dim", stats)}` : ""}`;
  const answer = string(value.answer); const error = string(value.error);
  if (!options.expanded) {
    const line = preview(error || answer, 100); if (line) text += `\n  ${theme.fg(error ? "error" : "toolOutput", line)}`;
    return new Text(text, 0, 0);
  }
  const container = new Container(); container.addChild(new Text(text, 0, 0));
  if (error) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("error", error), 0, 0)); }
  if (answer) { container.addChild(new Spacer(1)); container.addChild(new Markdown(answer, 0, 0, getMarkdownTheme())); }
  if (files.length) { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("muted", "Session changed files"), 0, 0)); container.addChild(new Text(files.map((file) => `  ${shortenHome(String(file))}`).join("\n"), 0, 0)); }
  if (value.stopReason) container.addChild(new Text(theme.fg("dim", `Stop reason: ${String(value.stopReason)}`), 0, 0));
  addExpandedBio(container, value.bio, theme);
  if (usage) {
    const usageParts = [
      `input ${formatTokens(usage.inputTokens) ?? "?"}`,
      `output ${formatTokens(usage.outputTokens) ?? "?"}`,
      `cache read ${formatTokens(usage.cacheReadTokens) ?? "?"}`,
      `cache write ${formatTokens(usage.cacheWriteTokens) ?? "?"}`,
      `total ${formatTokens(usage.totalTokens) ?? "?"}`,
      formatCost(usage.cost),
    ].filter(Boolean);
    container.addChild(new Text(theme.fg("dim", `Session usage: ${usageParts.join(" · ")}`), 0, 0));
  }
  container.addChild(new Text(theme.fg("dim", `Latest event #${String(value.latestSequence ?? "?")}`), 0, 0));
  expandedRaw(container, raw, theme);
  return container;
}

export function renderListCall(_args: any, theme: any): Text { return new Text(theme.fg("toolTitle", theme.bold("List subagents")), 0, 0); }

export function renderListResult(result: TextResultLike, options: any, theme: any, authoritativeStatuses?: ReadonlyMap<string, ChildCategory>): Text | Container {
  const { raw, value } = parseJsonResult(result); if (!value || !Array.isArray(value.children)) return rawText(result);
  const children = value.children.map(object).filter((child): child is JsonObject => child !== null);
  const statusOf = (child: JsonObject): ChildCategory => authoritativeStatuses?.get(string(child.id))
    ?? (child.alive === false ? "exited" : child.isStreaming === true ? "running" : child.lastAssistantTextPreview ? "settled" : "idle");
  const counts = new Map<string, number>(); for (const child of children) counts.set(statusOf(child), (counts.get(statusOf(child)) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => `${count} ${status}`).join(" · ") || "none";
  const shown = options.expanded ? children : children.slice(0, 4);
  const lines = shown.map((child) => {
    const status = statusOf(child);
    const access = child.write === true ? theme.fg("warning", accessMarker(child.write)) : theme.fg("accent", accessMarker(child.write));
    let line = `${icon(status, theme)} ${string(child.id, "?").padEnd(9)} ${access}  ${status.padEnd(8)} #${String(child.lastEventSequence ?? 0)}`;
    const bio = bioRecord(child.bio);
    // Blank bios add no collapsed noise; useful non-blank routing metadata gets one preview line.
    if (bio && isNonBlankBio(bio)) line += `\n    ${theme.fg("toolOutput", preview(bio.text, 100))}`;
    return line;
  });
  let text = `${theme.fg("toolTitle", theme.bold("Subagents"))} · ${theme.fg("dim", summary)}${lines.length ? `\n  ${lines.join("\n  ")}` : ""}`;
  if (!options.expanded && children.length > shown.length) text += `\n  ${theme.fg("muted", `… ${children.length - shown.length} more`)}`;
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container(); container.addChild(new Text(text, 0, 0));
  for (const child of children) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `${string(child.id)} · pid ${String(child.pid ?? "—")} · ${shortenHome(string(child.cwd))}`), 0, 0));
    if (child.lastAssistantTextPreview) container.addChild(new Text(theme.fg("toolOutput", preview(child.lastAssistantTextPreview, 100)), 0, 0));
    addExpandedBio(container, child.bio, theme, `Bio for ${string(child.id, "subagent")}`);
    if (child.exitCode !== null && child.exitCode !== undefined) container.addChild(new Text(theme.fg("muted", `exit ${String(child.exitCode)} · ${String(child.exitSignal ?? "no signal")}`), 0, 0));
  }
  expandedRaw(container, raw, theme); return container;
}

export function renderKillCall(args: any, theme: any): Text { return new Text(`${theme.fg("toolTitle", theme.bold("Kill"))} ${theme.fg("accent", string(args?.id, "subagent"))}`, 0, 0); }
export function renderKillResult(result: TextResultLike, options: any, theme: any): Text | Container {
  const { raw, value } = parseJsonResult(result); if (!value) return rawText(result);
  let text = `${icon("exited", theme)} ${theme.fg("toolTitle", string(value.id, "subagent"))} ${value.alive === false ? "terminated" : "still running"}`;
  if (value.exitSignal) text += `\n  ${theme.fg("dim", `signal ${String(value.exitSignal)}`)}`;
  else if (value.exitCode !== null && value.exitCode !== undefined) text += `\n  ${theme.fg("dim", `exit ${String(value.exitCode)}`)}`;
  if (!options.expanded) return new Text(text, 0, 0);
  const container = new Container(); container.addChild(new Text(text, 0, 0)); expandedRaw(container, raw, theme); return container;
}
