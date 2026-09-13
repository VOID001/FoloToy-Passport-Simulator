import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CommunityImportError,
  fetchCommunityFirmware,
} from "./community-import.mjs";
import {
  defaultLogger,
  errorLogFields,
  requestIdFrom,
} from "./logging.mjs";
import { attachNetworkBridge } from "./network-bridge.mjs";
import {
  createTrafficAnalytics,
  trafficAnalyticsEnabled,
} from "./traffic-analytics.mjs";

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
    "worker-src 'self'",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), serial=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
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

function requestPath(request) {
  try {
    return new URL(request.url, `http://${request.headers.host || "localhost"}`)
      .pathname;
  } catch {
    return "<invalid>";
  }
}

function startAccessLog(request, response, logger) {
  const startedAt = performance.now();
  const requestId = requestIdFrom(request.headers["x-request-id"]);
  const fields = {
    request_id: requestId,
    method: request.method,
    path: requestPath(request),
    http_version: request.httpVersion,
    remote_address: request.socket.remoteAddress,
    forwarded_for: request.headers["x-forwarded-for"],
    user_agent: request.headers["user-agent"],
  };
  let finished = false;

  response.setHeader("x-request-id", requestId);
  response.once("finish", () => {
    finished = true;
    logger.info("http_access", {
      ...fields,
      status: response.statusCode,
      response_bytes: Number(response.getHeader("content-length")) || undefined,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  });
  response.once("close", () => {
    if (finished) return;
    logger.warn("http_request_aborted", {
      ...fields,
      status: response.statusCode,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  });
  return requestId;
}

function trackPageView(request, response, trafficAnalytics) {
  if (
    !trafficAnalytics ||
    request.method !== "GET" ||
    !["/", "/index.html"].includes(requestPath(request))
  ) {
    return;
  }
  response.once("finish", () => {
    if (response.statusCode === 200) trafficAnalytics.record(request);
  });
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

async function serveCommunityFirmware(request, response, {
  communityFirmwareFetcher,
  logger,
  requestId,
}) {
  if (request.method !== "POST") {
    response.writeHead(405, { ...securityHeaders, allow: "POST" });
    response.end();
    return;
  }

  try {
    const payload = await readJsonRequest(request);
    const firmware = await communityFirmwareFetcher(payload?.url, undefined, {
      onRetry: ({ attempt, delayMs, error }) => {
        logger.warn("community_firmware_retry", {
          request_id: requestId,
          attempt,
          retry_delay_ms: delayMs,
          ...errorLogFields(error),
        });
      },
    });
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
    logger.info("community_firmware_imported", {
      request_id: requestId,
      firmware_slug: firmware.slug,
      firmware_sha256: firmware.sha256,
      firmware_bytes: firmware.bytes.byteLength,
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const status = error instanceof CommunityImportError
      ? error.status
      : timedOut ? 504 : 502;
    const log = status >= 500 ? logger.error : logger.warn;
    log("community_firmware_import_failed", {
      request_id: requestId,
      response_status: status,
      ...errorLogFields(error, {
        includeStack: !(error instanceof CommunityImportError) && !timedOut,
      }),
    });
    writeJson(response, status, {
      error: timedOut
        ? "FoloToy 社区请求超时"
        : error instanceof CommunityImportError
          ? error.message
          : "FoloToy 社区请求失败",
    });
  }
}

async function serve(request, response, {
  communityFirmwareFetcher,
  logger,
  requestId,
  runtimeConfig,
  trafficAnalytics,
}) {
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
  if (requestUrl.pathname === "/api/traffic-stats" && trafficAnalytics) {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { ...securityHeaders, allow: "GET, HEAD" });
      response.end();
      return;
    }
    writeJson(
      response,
      200,
      trafficAnalytics.snapshot(),
      request.method === "GET",
    );
    return;
  }
  if (requestUrl.pathname === "/api/community-firmware") {
    await serveCommunityFirmware(request, response, {
      communityFirmwareFetcher,
      logger,
      requestId,
    });
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
    const stream = createReadStream(filename);
    stream.on("error", (error) => {
      logger.error("static_asset_stream_failed", {
        request_id: requestId,
        path: requestUrl.pathname,
        ...errorLogFields(error, { includeStack: true }),
      });
      response.destroy(error);
    });
    stream.pipe(response);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      response.writeHead(404, securityHeaders);
      response.end("Not found");
      return;
    }
    logger.error("static_asset_read_failed", {
      request_id: requestId,
      path: requestUrl.pathname,
      ...errorLogFields(error, { includeStack: true }),
    });
    response.writeHead(500, securityHeaders);
    response.end("Internal server error");
  }
}

export function createAppServer(options = {}) {
  const logger = options.logger ?? defaultLogger;
  const analyticsEnabled =
    options.analyticsEnabled ??
    trafficAnalyticsEnabled(options.env ?? process.env);
  const trafficAnalytics = options.trafficAnalytics !== undefined
    ? options.trafficAnalytics
    : analyticsEnabled
      ? createTrafficAnalytics({
          logger,
          ...options.trafficAnalyticsOptions,
        })
      : null;
  const runtimeConfig = Object.freeze({
    allowLocalFirmwareUpload:
      options.allowLocalFirmwareUpload ?? localFirmwareUploadEnabled(),
  });
  const communityFirmwareFetcher =
    options.communityFirmwareFetcher ?? fetchCommunityFirmware;
  const server = http.createServer((request, response) => {
    const requestId = startAccessLog(request, response, logger);
    trackPageView(request, response, trafficAnalytics);
    serve(request, response, {
      communityFirmwareFetcher,
      logger,
      requestId,
      runtimeConfig,
      trafficAnalytics,
    }).catch((error) => {
      logger.error("http_request_failed", {
        request_id: requestId,
        method: request.method,
        path: requestPath(request),
        ...errorLogFields(error, { includeStack: true }),
      });
      if (!response.headersSent) {
        writeJson(response, 500, { error: "服务器内部错误" });
      } else {
        response.destroy(error);
      }
    });
  });
  server.on("clientError", (error, socket) => {
    logger.warn("http_client_error", {
      remote_address: socket.remoteAddress,
      ...errorLogFields(error),
    });
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });
  return attachNetworkBridge(server, {
    ...options.networkBridge,
    logger,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createAppServer();
  server.on("error", (error) => {
    defaultLogger.error("server_error", {
      host: HOST,
      port: PORT,
      ...errorLogFields(error, { includeStack: true }),
    });
  });
  server.listen(PORT, HOST, () => {
    defaultLogger.info("server_started", {
      host: HOST,
      port: PORT,
      url: `http://${HOST}:${PORT}`,
    });
  });
}
