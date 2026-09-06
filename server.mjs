import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommunityImportError,
  fetchCommunityFirmware,
} from "./community-import.mjs";
import { attachNetworkBridge } from "./network-bridge.mjs";

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4190);
const directory = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(directory, "public");
const MAX_REQUEST_BYTES = 8 * 1024;
const LOCAL_FIRMWARE_UPLOAD_ENV = "EMULATOR_ALLOW_LOCAL_FIRMWARE_UPLOAD";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".zip": "application/zip",
};
const securityHeaders = {
  "content-security-policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; img-src 'self' data:; " +
    "media-src 'self'; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    "worker-src 'self'; frame-ancestors 'none'",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), serial=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function assetPath(pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filename = path.resolve(publicRoot, `.${requested}`);
  return filename.startsWith(`${publicRoot}${path.sep}`) ? filename : null;
}

function writeJson(response, status, payload, includeBody = true) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    ...securityHeaders,
    "cache-control": "no-store",
    "content-length": body.byteLength,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(includeBody ? body : undefined);
}

export function localFirmwareUploadEnabled({
  env = process.env,
  argv = process.argv,
} = {}) {
  if (env[LOCAL_FIRMWARE_UPLOAD_ENV] !== undefined) {
    return env[LOCAL_FIRMWARE_UPLOAD_ENV] === "1";
  }
  return argv.includes("--allow-local-firmware-upload");
}

async function readJsonRequest(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new CommunityImportError("请求内容过大", 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new CommunityImportError("请求内容不是有效 JSON");
  }
}

async function serveCommunityFirmware(request, response) {
  if (request.method !== "POST") {
    response.writeHead(405, { ...securityHeaders, allow: "POST" });
    response.end();
    return;
  }

  try {
    const payload = await readJsonRequest(request);
    const firmware = await fetchCommunityFirmware(payload?.url);
    response.writeHead(200, {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-length": firmware.bytes.byteLength,
      "content-type": "application/octet-stream",
      "x-firmware-name": encodeURIComponent(firmware.title),
      "x-firmware-sha256": firmware.sha256,
      "x-firmware-slug": encodeURIComponent(firmware.slug),
    });
    response.end(firmware.bytes);
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const status = error instanceof CommunityImportError
      ? error.status
      : timedOut ? 504 : 502;
    if (!(error instanceof CommunityImportError) && !timedOut) {
      console.error("Community firmware import failed:", error);
    }
    writeJson(response, status, {
      error: timedOut
        ? "FoloToy 社区请求超时"
        : error instanceof CommunityImportError
          ? error.message
          : "FoloToy 社区请求失败",
    });
  }
}

async function serve(request, response, runtimeConfig) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  if (requestUrl.pathname === "/healthz") {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" });
      response.end();
      return;
    }
    const body = Buffer.from('{"status":"ok"}\n');
    response.writeHead(200, {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-length": body.byteLength,
      "content-type": "application/json; charset=utf-8",
    });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }
  if (requestUrl.pathname === "/api/runtime-config") {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" });
      response.end();
      return;
    }
    writeJson(response, 200, runtimeConfig, request.method === "GET");
    return;
  }
  if (requestUrl.pathname === "/api/community-firmware") {
    await serveCommunityFirmware(request, response);
    return;
  }

  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" });
    response.end();
    return;
  }

  const filename = assetPath(requestUrl.pathname);
  if (!filename) {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
    return;
  }

  try {
    const metadata = await stat(filename);
    response.writeHead(200, {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-length": metadata.size,
      "content-type": mimeTypes[path.extname(filename)] || "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filename).pipe(response);
  } catch {
    response.writeHead(404, securityHeaders);
    response.end("Not found");
  }
}

export function createAppServer(options = {}) {
  const runtimeConfig = Object.freeze({
    allowLocalFirmwareUpload:
      options.allowLocalFirmwareUpload ?? localFirmwareUploadEnabled(),
  });
  const server = http.createServer(
    (request, response) => serve(request, response, runtimeConfig),
  );
  return attachNetworkBridge(server, options.networkBridge);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createAppServer().listen(PORT, HOST, () => {
    console.log(`AI Passport WASM emulator: http://${HOST}:${PORT}`);
  });
}
