import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { MAX_FIRMWARE_BYTES } from "./public/firmware.js";

export const COMMUNITY_ORIGIN = "https://ai-passport.folotoy.cn";

export class CommunityImportError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CommunityImportError";
    this.status = status;
  }
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
    throw new CommunityImportError(message, response.status === 404 ? 404 : 502);
  }
  if (!payload || typeof payload !== "object") {
    throw new CommunityImportError("FoloToy 社区返回了无效数据", 502);
  }
  return payload;
}

export async function fetchCommunityFirmware(value, fetchImpl = fetch) {
  const reference = parseCommunityPlayUrl(value);
  const metadataPath = reference.kind === "id"
    ? `/api/plays/id/${encodeURIComponent(reference.value)}`
    : `/api/plays/${encodeURIComponent(reference.value)}`;
  const metadataResponse = await fetchImpl(`${COMMUNITY_ORIGIN}${metadataPath}`, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
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

  const firmwareResponse = await fetchImpl(downloadUrl, {
    headers: { accept: "application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!firmwareResponse.ok) {
    throw new CommunityImportError("社区固件下载失败", 502);
  }
  const bytes = await readLimitedBody(firmwareResponse, MAX_FIRMWARE_BYTES);
  if (bytes.byteLength !== firmware.size) {
    throw new CommunityImportError("社区固件大小与发布信息不一致", 502);
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== firmware.sha256.toLowerCase()) {
    throw new CommunityImportError("社区固件 SHA-256 校验失败", 502);
  }

  const title = String(play.title?.zh || play.title?.en || play.slug || "社区固件");
  return {
    bytes,
    sha256,
    slug: String(play.slug || reference.value),
    title,
  };
}
