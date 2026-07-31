import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const expectedPeers = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
];

assert.equal(manifest.name, "children-of-pi");
assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
assert.equal(manifest.type, "module");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.engines?.node, ">=22.19.0");
assert.ok(manifest.keywords?.includes("pi-package"));
assert.ok(manifest.keywords?.includes("pi-extension"));
assert.equal(Object.hasOwn(manifest, "dependencies"), false, "Pi core imports must remain peer-only");
assert.deepEqual(Object.keys(manifest.peerDependencies ?? {}).sort(), expectedPeers);
for (const dependency of expectedPeers) {
  assert.equal(manifest.peerDependencies[dependency], "*");
}

assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
for (const entry of manifest.pi.extensions) {
  await access(resolve(root, entry));
}

console.log("Package manifest is valid for a peer-only Pi extension.");
