const UI_SETTING_COMMANDS = new Set(["setStatus", "setWidget", "setTitle"]);
const READ_ONLY_TOOLS = "read,grep,find,ls";

export function childPiSpawnArgs(write: boolean, projectTrusted: boolean): string[] {
  const args = ["--mode", "rpc", "--no-session"];
  if (!write) args.push("--tools", READ_ONLY_TOOLS);
  if (projectTrusted) args.push("--approve");
  return args;
}

export function assertAllowedChildRpcCommand(command: Record<string, unknown>): void {
  const type = String(command.type ?? "");
  if (type.startsWith("set_") || type.startsWith("cycle_") || UI_SETTING_COMMANDS.has(type)) {
    throw new Error(`Children of Pi does not allow changing child Pi settings (${type}).`);
  }
}
