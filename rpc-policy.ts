const UI_SETTING_COMMANDS = new Set(["setStatus", "setWidget", "setTitle"]);

export function assertAllowedChildRpcCommand(command: Record<string, unknown>): void {
  const type = String(command.type ?? "");
  if (type.startsWith("set_") || type.startsWith("cycle_") || UI_SETTING_COMMANDS.has(type)) {
    throw new Error(`Children of Pi does not allow changing child Pi settings (${type}).`);
  }
}
