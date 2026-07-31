import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const temporaryRoot = await mkdtemp(join(tmpdir(), "children-of-pi-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited with ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

try {
  const packDirectory = join(temporaryRoot, "pack");
  const hostDirectory = join(temporaryRoot, "host");
  const configDirectory = join(temporaryRoot, "config");
  await Promise.all([
    mkdir(packDirectory),
    mkdir(hostDirectory),
    mkdir(configDirectory),
  ]);
  await writeFile(join(hostDirectory, "package.json"), `${JSON.stringify({
    name: "children-of-pi-smoke-host",
    version: "0.0.0",
    private: true,
  }, null, 2)}\n`);

  const packResult = JSON.parse(run(npm, [
    "pack",
    "--json",
    "--pack-destination",
    packDirectory,
  ], { cwd: root, timeout: 60_000 }));
  assert.equal(packResult.length, 1);
  const tarball = join(packDirectory, basename(packResult[0].filename));

  run(npm, [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--include=peer",
    tarball,
  ], { cwd: hostDirectory, timeout: 180_000 });

  const pi = join(hostDirectory, "node_modules", ".bin", process.platform === "win32" ? "pi.cmd" : "pi");
  const extensionDirectory = join(hostDirectory, "node_modules", manifest.name);
  const env = {
    ...process.env,
    CI: "1",
    PI_CODING_AGENT_DIR: configDirectory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) {
    delete env[key];
  }

  const output = run(pi, [
    "--mode", "rpc",
    "--no-session",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-tools",
    "--no-approve",
    "--extension", extensionDirectory,
  ], {
    cwd: hostDirectory,
    env,
    input: `${JSON.stringify({ id: "extension-load", type: "get_commands" })}\n`,
    timeout: 30_000,
  });

  const records = output.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.some((record) => record.type === "extension_error"), false);
  const response = records.find((record) => record.id === "extension-load");
  assert.equal(response?.success, true);
  assert.equal(response?.command, "get_commands");
  assert.ok(response.data.commands.some((command) => command.name === "child-bio" && command.source === "extension"));

  console.log("Packed extension loaded cleanly in an isolated Pi RPC host.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
