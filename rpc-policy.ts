import { realpathSync } from "node:fs";

const UI_SETTING_COMMANDS = new Set(["setStatus", "setWidget", "setTitle"]);
const READ_ONLY_TOOLS = "read,grep,find,ls";

export function childPiSpawnArgs(write: boolean, projectTrusted: boolean): string[] {
  const args = ["--mode", "rpc", "--no-session"];
  if (!write) args.push("--tools", READ_ONLY_TOOLS);
  args.push(projectTrusted ? "--approve" : "--no-approve");
  return args;
}

export function isSameCanonicalDirectory(first: string, second: string): boolean {
  try {
    return realpathSync(first) === realpathSync(second);
  } catch {
    return false;
  }
}

export function assertAllowedChildRpcCommand(command: Record<string, unknown>, write: boolean): void {
  const type = String(command.type ?? "");
  if (type.startsWith("set_") || type.startsWith("cycle_") || UI_SETTING_COMMANDS.has(type)) {
    throw new Error(`Children of Pi does not allow changing child Pi settings (${type}).`);
  }
  if (type === "bash" && !write) {
    throw new Error("Children of Pi does not allow direct RPC bash commands for read-only children.");
  }
}
