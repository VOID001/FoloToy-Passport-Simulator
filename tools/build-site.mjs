import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(directory, "..");
const publicRoot = path.join(projectRoot, "public");
const outputRoot = path.join(projectRoot, "dist");
const packagePath = path.join(projectRoot, "package.json");
const catalogPath = path.join(publicRoot, "assets", "firmware", "catalog.json");
const manifestPath = path.join(publicRoot, "wasm", "manifest.json");

async function sha256(filename) {
  return createHash("sha256").update(await readFile(filename)).digest("hex");
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, filename));
    else files.push(path.relative(root, filename));
  }
  return files.sort();
}

const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const runtimeManifest = JSON.parse(await readFile(manifestPath, "utf8"));

assert.equal(catalog.schemaVersion, 1, "unsupported firmware catalog schema");
assert.ok(Array.isArray(catalog.firmwares) && catalog.firmwares.length > 0);
assert.equal(
  new Set(catalog.firmwares.map((firmware) => firmware.id)).size,
  catalog.firmwares.length,
  "firmware catalog IDs must be unique",
);

for (const firmware of catalog.firmwares) {
  assert.match(firmware.file, /^\/assets\/firmware\/[a-z0-9-]+\.bin$/);
  const filename = path.join(publicRoot, firmware.file.slice(1));
  const metadata = await stat(filename);
  assert.equal(metadata.size, firmware.bytes, `${firmware.id} size mismatch`);
  assert.equal(await sha256(filename), firmware.sha256, `${firmware.id} SHA-256 mismatch`);
}

const defaultFirmware = catalog.firmwares.find(
  (firmware) => firmware.id === catalog.default,
);
assert.ok(defaultFirmware, "default firmware is missing from catalog");
assert.equal(
  runtimeManifest.firmware,
  defaultFirmware.file,
  "runtime manifest does not use the catalog default",
);

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await cp(publicRoot, path.join(outputRoot, "public"), { recursive: true });
await cp(
  path.join(projectRoot, "server.mjs"),
  path.join(outputRoot, "server.mjs"),
);
await cp(
  path.join(projectRoot, "community-import.mjs"),
  path.join(outputRoot, "community-import.mjs"),
);
await cp(
  path.join(projectRoot, "logging.mjs"),
  path.join(outputRoot, "logging.mjs"),
);
await cp(
  path.join(projectRoot, "network-bridge.mjs"),
  path.join(outputRoot, "network-bridge.mjs"),
);
await cp(
  path.join(projectRoot, "network-packets.mjs"),
  path.join(outputRoot, "network-packets.mjs"),
);
await cp(
  path.join(projectRoot, "README.md"),
  path.join(outputRoot, "README.md"),
);
await cp(
  path.join(projectRoot, "DEPLOYMENT.md"),
  path.join(outputRoot, "DEPLOYMENT.md"),
);

const releasePackage = {
  name: packageMetadata.name,
  version: packageMetadata.version,
  private: true,
  type: "module",
  description: packageMetadata.description,
  scripts: { start: "node server.mjs" },
  engines: packageMetadata.engines,
};
await writeFile(
  path.join(outputRoot, "package.json"),
  `${JSON.stringify(releasePackage, null, 2)}\n`,
);

const releaseManifest = {
  schemaVersion: 1,
  name: packageMetadata.name,
  version: packageMetadata.version,
  entrypoint: "server.mjs",
  healthcheck: "/healthz",
  publicRoot: "public",
  firmwareCatalog: "public/assets/firmware/catalog.json",
  defaultFirmware: defaultFirmware.id,
  runtime: runtimeManifest.runtime,
  board: runtimeManifest.board,
};
await writeFile(
  path.join(outputRoot, "release-manifest.json"),
  `${JSON.stringify(releaseManifest, null, 2)}\n`,
);

const files = (await listFiles(outputRoot))
  .filter((filename) => filename !== "SHA256SUMS");
const checksums = [];
for (const filename of files) {
  checksums.push(`${await sha256(path.join(outputRoot, filename))}  ${filename}`);
}
await writeFile(
  path.join(outputRoot, "SHA256SUMS"),
  `${checksums.join("\n")}\n`,
);

const totalBytes = await files.reduce(async (sumPromise, filename) => {
  const sum = await sumPromise;
  return sum + (await stat(path.join(outputRoot, filename))).size;
}, Promise.resolve(0));

process.stdout.write(
  `Built dist/ with ${files.length + 1} files (${totalBytes.toLocaleString("en-US")} bytes)\n`,
);
