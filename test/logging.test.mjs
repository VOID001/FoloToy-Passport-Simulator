import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { CommunityImportError } from "../community-import.mjs";
import { createLogger } from "../logging.mjs";
import { createAppServer } from "../server.mjs";

function captureLogger(records) {
  return createLogger({
    clock: () => new Date("2026-09-08T12:00:00.000Z"),
    write: (_level, line) => records.push(JSON.parse(line)),
  });
}

test("writes structured JSON log records", () => {
  const records = [];
  const logger = captureLogger(records);

  logger.info("server_started", { port: 4190 });

  assert.deepEqual(records, [{
    timestamp: "2026-09-08T12:00:00.000Z",
    level: "info",
    event: "server_started",
    port: 4190,
  }]);
});

test("logs HTTP access and upstream community failures with one request ID", async (t) => {
  const records = [];
  const upstreamError = new CommunityImportError(
    "社区固件下载失败",
    502,
    {
      retryable: true,
      details: {
        upstream_stage: "firmware_download",
        upstream_status: 429,
        upstream_request_id: "upstream-request",
      },
    },
  );
  upstreamError.attempts = 4;
  const server = createAppServer({
    allowLocalFirmwareUpload: false,
    communityFirmwareFetcher: async (_value, _fetchImpl, { onRetry }) => {
      onRetry({ attempt: 1, delayMs: 250, error: upstreamError });
      throw upstreamError;
    },
    logger: captureLogger(records),
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${origin}/api/community-firmware?ignored=secret`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "request-123",
    },
    body: JSON.stringify({
      url: "https://ai-passport.folotoy.cn/plays/75/",
    }),
  });
  await response.arrayBuffer();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-request-id"), "request-123");
  const failure = records.find(
    (record) => record.event === "community_firmware_import_failed",
  );
  assert.deepEqual({
    request_id: failure.request_id,
    response_status: failure.response_status,
    upstream_stage: failure.upstream_stage,
    upstream_status: failure.upstream_status,
    upstream_request_id: failure.upstream_request_id,
    attempts: failure.attempts,
  }, {
    request_id: "request-123",
    response_status: 502,
    upstream_stage: "firmware_download",
    upstream_status: 429,
    upstream_request_id: "upstream-request",
    attempts: 4,
  });

  const retry = records.find((record) => record.event === "community_firmware_retry");
  assert.equal(retry.request_id, "request-123");
  assert.equal(retry.attempt, 1);
  assert.equal(retry.retry_delay_ms, 250);
  assert.equal(retry.upstream_status, 429);

  const access = records.find((record) => record.event === "http_access");
  assert.equal(access.request_id, "request-123");
  assert.equal(access.method, "POST");
  assert.equal(access.path, "/api/community-firmware");
  assert.equal(access.status, 502);
  assert.equal(typeof access.duration_ms, "number");
});
