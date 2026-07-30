export type JsonObject = Record<string, unknown>;

export interface TextResultLike {
  content?: unknown;
  details?: unknown;
  isError?: unknown;
}

export function extractResultText(result: TextResultLike | null | undefined): string {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null
      && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function parseJsonResult(result: TextResultLike | null | undefined): {
  raw: string;
  value: JsonObject | null;
} {
  const raw = extractResultText(result);
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return { raw, value: null };
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? { raw, value: value as JsonObject }
      : { raw, value: null };
  } catch {
    return { raw, value: null };
  }
}

export interface EventSummary {
  count: number;
  firstSequence: number | null;
  lastSequence: number | null;
  hasMore: boolean;
  tools: number;
  messages: number;
  settlements: number;
  exits: number;
  protocolErrors: number;
}

export function summarizeEvents(value: JsonObject): EventSummary {
  const events = Array.isArray(value.events) ? value.events : [];
  const sequences = events
    .map((item) => typeof item === "object" && item !== null ? (item as JsonObject).sequence : null)
    .filter((sequence): sequence is number => typeof sequence === "number");
  const types = events.map((item) => {
    if (typeof item !== "object" || item === null) return "";
    const event = (item as JsonObject).event;
    return typeof event === "object" && event !== null ? String((event as JsonObject).type ?? "") : "";
  });
  return {
    count: events.length,
    firstSequence: sequences[0] ?? null,
    lastSequence: sequences.at(-1) ?? null,
    hasMore: value.hasMore === true,
    tools: types.filter((type) => type === "tool_execution_start").length,
    messages: types.filter((type) => type === "message_end").length,
    settlements: types.filter((type) => type === "agent_settled").length,
    exits: types.filter((type) => type === "process_exit").length,
    protocolErrors: types.filter((type) => type === "protocol_parse_error" || type === "process_error").length,
  };
}
