import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  COMMUNITY_ORIGIN,
  MAX_FIRMWARE_BYTES,
} from "./public/firmware.js";

export { COMMUNITY_ORIGIN };

export const COMMUNITY_DOWNLOAD_RETRIES = 3;
const COMMUNITY_RETRY_BASE_DELAY_MS = 250;

export class CommunityImportError extends Error {
  constructor(message, status = 400, { retryable = false, details } = {}) {
    super(message);
    this.name = "CommunityImportError";
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function retryCommunityOperation(operation, retryDelay, onRetry) {
  for (let retryCount = 0; ; retryCount += 1) {
    try {
      return await operation();
    } catch (error) {
      if (error && typeof error === "object") {
        error.attempts = retryCount + 1;
      }
      const retryable =
        !(error instanceof CommunityImportError) || error.retryable;
      if (!retryable || retryCount >= COMMUNITY_DOWNLOAD_RETRIES) throw error;
      const delayMs = COMMUNITY_RETRY_BASE_DELAY_MS * (2 ** retryCount);
      try {
        onRetry({
          attempt: retryCount + 1,
          delayMs,
          error,
        });
      } catch {
        // Diagnostics must never break a firmware import.
      }
      await retryDelay(delayMs);
    }
  }
}

function upstreamResponseDetails(stage, response) {
  return {
    upstream_stage: stage,
    upstream_status: response.status,
    upstream_status_text: response.statusText,
    upstream_request_id: response.headers.get("x-request-id") || undefined,
    retry_after: response.headers.get("retry-after") || undefined,
  };
}

export function parseCommunityPlayUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CommunityImportError("请输入 FoloToy 社区玩法链接");
  }
  if (value.length > 2048) {
    throw new CommunityImportError("社区玩法链接过长");
  }

  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new CommunityImportError("社区玩法链接格式无效");
  }
  if (url.origin !== COMMUNITY_ORIGIN || url.username || url.password) {
    throw new CommunityImportError("仅支持 ai-passport.folotoy.cn 的 HTTPS 链接");
  }

  let segments;
  try {
    segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new CommunityImportError("社区玩法链接格式无效");
  }
  if (segments[0] === "en") segments = segments.slice(1);
  if (segments[0] !== "plays") {
    throw new CommunityImportError("请输入 FoloToy 社区的玩法详情链接");
  }

  if (segments[1] === "community") {
    if (
      segments.length < 3 ||
      segments.length > 4 ||
      !/^[1-9]\d*$/.test(segments[2]) ||
      (segments[3] && !/^[a-z0-9-]+$/.test(segments[3]))
    ) {
      throw new CommunityImportError("社区玩法详情链接格式无效");
    }
    return { kind: "id", value: segments[2] };
  }

  if (segments.length !== 2) {
    throw new CommunityImportError("请输入具体玩法的详情链接");
  }
  if (/^[1-9]\d*$/.test(segments[1])) {
    return { kind: "id", value: segments[1] };
  }
  if (/^[a-z0-9-]+$/.test(segments[1])) {
    return { kind: "slug", value: segments[1] };
  }
  throw new CommunityImportError("社区玩法详情链接格式无效");
}

async function readLimitedBody(response, limit) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new CommunityImportError("社区固件超过 ESP32-C3 的 8 MB Flash 容量", 422);
  }

  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new CommunityImportError("社区固件超过 ESP32-C3 的 8 MB Flash 容量", 422);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new CommunityImportError("社区固件超过 ESP32-C3 的 8 MB Flash 容量", 422);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function readMetadata(response) {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The public API should return JSON; use a stable local error if it does not.
  }
  if (!response.ok) {
    const message = response.status === 404
      ? "找不到这个社区玩法"
      : "FoloToy 社区暂时无法读取";
    throw new CommunityImportError(message, response.status === 404 ? 404 : 502, {
      details: upstreamResponseDetails("metadata", response),
    });
  }
  if (!payload || typeof payload !== "object") {
    throw new CommunityImportError("FoloToy 社区返回了无效数据", 502, {
      details: upstreamResponseDetails("metadata", response),
    });
  }
  return payload;
}

export async function fetchCommunityFirmware(
  value,
  fetchImpl = fetch,
  {
    onRetry = () => {},
    retryDelay = waitForRetry,
  } = {},
) {
  const reference = parseCommunityPlayUrl(value);
  const metadataPath = reference.kind === "id"
    ? `/api/plays/id/${encodeURIComponent(reference.value)}`
    : `/api/plays/${encodeURIComponent(reference.value)}`;
  const metadataResponse = await retryCommunityOperation(async () => {
    const response = await fetchImpl(`${COMMUNITY_ORIGIN}${metadataPath}`, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok && isRetryableHttpStatus(response.status)) {
      throw new CommunityImportError(
        "FoloToy 社区暂时无法读取",
        502,
        {
          retryable: true,
          details: upstreamResponseDetails("metadata", response),
        },
      );
    }
    return response;
  }, retryDelay, onRetry);
  const payload = await readMetadata(metadataResponse);
  const play = payload?.play;
  const firmware = play?.firmware;

  if (!payload?.ok || !play || play.status !== "published") {
    throw new CommunityImportError("该社区玩法尚未发布", 422);
  }
  if (!firmware?.available) {
    throw new CommunityImportError("该社区玩法没有可下载固件", 422);
  }
  if (firmware.format !== "esp-merged-0x0") {
    throw new CommunityImportError("该玩法不是可直接运行的 Full Flash 镜像", 422);
  }
  if (
    !Number.isInteger(firmware.size) ||
    firmware.size <= 0 ||
    firmware.size > MAX_FIRMWARE_BYTES
  ) {
    throw new CommunityImportError("社区固件大小无效或超过 8 MB", 422);
  }
  if (!/^[a-f0-9]{64}$/i.test(firmware.sha256 || "")) {
    throw new CommunityImportError("社区固件缺少有效的 SHA-256", 422);
  }

  const downloadUrl = new URL(firmware.url || play.downloadUrl || "", COMMUNITY_ORIGIN);
  if (
    downloadUrl.origin !== COMMUNITY_ORIGIN ||
    !downloadUrl.pathname.startsWith("/api/download/")
  ) {
    throw new CommunityImportError("社区固件下载地址无效", 422);
  }

  const { bytes, sha256 } = await retryCommunityOperation(async () => {
    const firmwareResponse = await fetchImpl(downloadUrl, {
      headers: { accept: "application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!firmwareResponse.ok) {
      throw new CommunityImportError(
        "社区固件下载失败",
        502,
        {
          retryable: isRetryableHttpStatus(firmwareResponse.status),
          details: upstreamResponseDetails("firmware_download", firmwareResponse),
        },
      );
    }
    const downloadedBytes = await readLimitedBody(
      firmwareResponse,
      MAX_FIRMWARE_BYTES,
    );
    if (downloadedBytes.byteLength !== firmware.size) {
      throw new CommunityImportError(
        "社区固件大小与发布信息不一致",
        502,
        {
          retryable: true,
          details: {
            upstream_stage: "firmware_validation",
            expected_bytes: firmware.size,
            actual_bytes: downloadedBytes.byteLength,
          },
        },
      );
    }

    const downloadedSha256 = createHash("sha256")
      .update(downloadedBytes)
      .digest("hex");
    if (downloadedSha256 !== firmware.sha256.toLowerCase()) {
      throw new CommunityImportError(
        "社区固件 SHA-256 校验失败",
        502,
        {
          retryable: true,
          details: {
            upstream_stage: "firmware_validation",
            expected_sha256: firmware.sha256.toLowerCase(),
            actual_sha256: downloadedSha256,
          },
        },
      );
    }
    return { bytes: downloadedBytes, sha256: downloadedSha256 };
  }, retryDelay, onRetry);

  const title = String(play.title?.zh || play.title?.en || play.slug || "社区固件");
  return {
    bytes,
    sha256,
    slug: String(play.slug || reference.value),
    title,
  };
}
