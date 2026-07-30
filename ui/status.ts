export type ChildCategory = "running" | "idle" | "settled" | "failed" | "aborted" | "exited";

export interface ChildStatusLike {
  alive: boolean;
  isStreaming: boolean;
  stopReason?: string | null;
}

export const CATEGORY_ORDER: ChildCategory[] = ["running", "failed", "aborted", "settled", "idle", "exited"];

export function classifyChild(child: ChildStatusLike): ChildCategory {
  if (!child.alive) return "exited";
  if (child.isStreaming) return "running";
  if (child.stopReason === "error") return "failed";
  if (child.stopReason === "aborted") return "aborted";
  if (child.stopReason === null || child.stopReason === undefined) return "idle";
  return "settled";
}

export function countChildren(children: Iterable<ChildStatusLike>): Record<ChildCategory, number> {
  const counts: Record<ChildCategory, number> = {
    running: 0, idle: 0, settled: 0, failed: 0, aborted: 0, exited: 0,
  };
  for (const child of children) counts[classifyChild(child)]++;
  return counts;
}

export function footerParts(children: Iterable<ChildStatusLike>): Array<{ category: ChildCategory; count: number }> {
  const counts = countChildren(children);
  return CATEGORY_ORDER
    .filter((category) => counts[category] > 0)
    .map((category) => ({ category, count: counts[category] }));
}

export function footerTone(parts: Array<{ category: ChildCategory; count: number }>): "accent" | "error" | "success" | "muted" {
  if (parts.some((part) => part.category === "running")) return "accent";
  if (parts.some((part) => part.category === "failed" || part.category === "aborted")) return "error";
  if (parts.length > 0 && parts.every((part) => part.category === "idle")) return "muted";
  return "success";
}

export function footerText(parts: Array<{ category: ChildCategory; count: number }>): string | undefined {
  if (parts.length === 0) return undefined;
  return `subagents: ${parts.map(({ category, count }) => `${count} ${category}`).join(" · ")}`;
}
