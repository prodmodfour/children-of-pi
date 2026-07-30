import { homedir } from "node:os";

export function shortenHome(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function preview(value: unknown, max = 72): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/gu, " ").trim();
  const chars = Array.from(line);
  return chars.length <= max ? line : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

export function formatTokens(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function formatCost(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function accessMarker(write: unknown): "RO" | "RW" {
  return write === true ? "RW" : "RO";
}
