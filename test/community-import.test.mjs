import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  COMMUNITY_ORIGIN,
  COMMUNITY_DOWNLOAD_RETRIES,
  CommunityImportError,
  fetchCommunityFirmware,
  parseCommunityPlayUrl,
} from "../community-import.mjs";
import { COMMUNITY_ORIGIN as PUBLIC_COMMUNITY_ORIGIN } from "../public/firmware.js";

test("shares the community origin with the browser URL resolver", () => {
  assert.equal(COMMUNITY_ORIGIN, PUBLIC_COMMUNITY_ORIGIN);
});

test("parses supported FoloToy community detail URLs", () => {
  assert.deepEqual(
    parseCommunityPlayUrl("https://ai-passport.folotoy.cn/plays/71/"),
    { kind: "id", value: "71" },
  );
  assert.deepEqual(
    parseCommunityPlayUrl("https://ai-passport.folotoy.cn/en/plays/answer-book/"),
    { kind: "slug", value: "answer-book" },
  );
  assert.deepEqual(
    parseCommunityPlayUrl("https://ai-passport.folotoy.cn/plays/community/61/doom/"),
    { kind: "id", value: "61" },
  );
});

test("rejects list pages, non-HTTPS origins, and unrelated hosts", () => {
  for (const value of [
    "https://ai-passport.folotoy.cn/plays/",
    "http://ai-passport.folotoy.cn/plays/71/",
    "https://example.com/plays/71/",
    "https://ai-passport.folotoy.cn/guides/71/",
  ]) {
    assert.throws(() => parseCommunityPlayUrl(value), CommunityImportError);
  }
});

test("downloads and verifies published merged firmware", async () => {
  const bytes = new Uint8Array([0xe9, 0x03, 0x02, 0x01]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/api/plays/id/71")) {
      return Response.json({
        ok: true,
        play: {
          slug: "answer-book",
          status: "published",
          title: { zh: "答案之书" },
          firmware: {
            available: true,
            format: "esp-merged-0x0",
            size: bytes.byteLength,
            sha256,
            url: "/api/download/official/answer-book",
          },
        },
      });
    }
    return new Response(bytes, {
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/octet-stream",
      },
    });
  };

  const result = await fetchCommunityFirmware(
    "https://ai-passport.folotoy.cn/plays/71/",
    fetchImpl,
  );
  assert.equal(result.title, "答案之书");
  assert.equal(result.slug, "answer-book");
  assert.equal(result.sha256, sha256);
  assert.deepEqual(result.bytes, Buffer.from(bytes));
  assert.deepEqual(calls, [
    "https://ai-passport.folotoy.cn/api/plays/id/71",
    "https://ai-passport.folotoy.cn/api/download/official/answer-book",
  ]);
});

test("retries timed-out firmware downloads up to three times", async () => {
  const bytes = new Uint8Array([0xe9, 0x03, 0x02, 0x01]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const retryDelays = [];
  let downloadAttempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/plays/id/71")) {
      return Response.json({
        ok: true,
        play: {
          slug: "answer-book",
          status: "published",
          title: { zh: "答案之书" },
          firmware: {
            available: true,
            format: "esp-merged-0x0",
            size: bytes.byteLength,
            sha256,
            url: "/api/download/official/answer-book",
          },
        },
      });
    }
    downloadAttempts += 1;
    if (downloadAttempts <= COMMUNITY_DOWNLOAD_RETRIES) {
      const error = new Error("download timed out");
      error.name = "TimeoutError";
      throw error;
    }
    return new Response(bytes);
  };

  const result = await fetchCommunityFirmware(
    "https://ai-passport.folotoy.cn/plays/71/",
    fetchImpl,
    { retryDelay: async (delayMs) => retryDelays.push(delayMs) },
  );

  assert.deepEqual(result.bytes, Buffer.from(bytes));
  assert.equal(downloadAttempts, COMMUNITY_DOWNLOAD_RETRIES + 1);
  assert.deepEqual(retryDelays, [250, 500, 1000]);
});

test("reports a timeout only after all firmware download retries fail", async () => {
  const bytes = new Uint8Array([0xe9, 0x03, 0x02, 0x01]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let downloadAttempts = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/plays/id/71")) {
      return Response.json({
        ok: true,
        play: {
          slug: "answer-book",
          status: "published",
          title: { zh: "答案之书" },
          firmware: {
            available: true,
            format: "esp-merged-0x0",
            size: bytes.byteLength,
            sha256,
            url: "/api/download/official/answer-book",
          },
        },
      });
    }
    downloadAttempts += 1;
    const error = new Error("download timed out");
    error.name = "TimeoutError";
    throw error;
  };

  await assert.rejects(
    fetchCommunityFirmware(
      "https://ai-passport.folotoy.cn/plays/71/",
      fetchImpl,
      { retryDelay: async () => {} },
    ),
    { name: "TimeoutError", message: "download timed out" },
  );
  assert.equal(downloadAttempts, COMMUNITY_DOWNLOAD_RETRIES + 1);
});

test("rejects firmware whose bytes do not match published SHA-256", async () => {
  const bytes = new Uint8Array([0xe9, 0x03, 0x02, 0x01]);
  const fetchImpl = async (url) => {
    if (String(url).includes("/api/plays/answer-book")) {
      return Response.json({
        ok: true,
        play: {
          slug: "answer-book",
          status: "published",
          title: { en: "Answer Book" },
          firmware: {
            available: true,
            format: "esp-merged-0x0",
            size: bytes.byteLength,
            sha256: "0".repeat(64),
            url: "/api/download/official/answer-book",
          },
        },
      });
    }
    return new Response(bytes);
  };

  await assert.rejects(
    fetchCommunityFirmware(
      "https://ai-passport.folotoy.cn/plays/answer-book/",
      fetchImpl,
      { retryDelay: async () => {} },
    ),
    /SHA-256 校验失败/,
  );
});
