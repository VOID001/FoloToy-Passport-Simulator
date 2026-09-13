import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createAppServer } from "../server.mjs";
import { trafficAnalyticsEnabled } from "../traffic-analytics.mjs";

function captureLogger(records) {
  return {
    debug: (event, fields) => records.push({ level: "debug", event, ...fields }),
    info: (event, fields) => records.push({ level: "info", event, ...fields }),
    warn: (event, fields) => records.push({ level: "warn", event, ...fields }),
    error: (event, fields) => records.push({ level: "error", event, ...fields }),
  };
}

async function listen(server, t) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("traffic analytics requires an explicit environment flag", () => {
  assert.equal(trafficAnalyticsEnabled({}), false);
  assert.equal(trafficAnalyticsEnabled({ EMULATOR_TRAFFIC_ANALYTICS: "0" }), false);
  assert.equal(trafficAnalyticsEnabled({ EMULATOR_TRAFFIC_ANALYTICS: "true" }), false);
  assert.equal(trafficAnalyticsEnabled({ EMULATOR_TRAFFIC_ANALYTICS: "1" }), true);
});

test("traffic stats endpoint is unavailable when analytics is disabled", async (t) => {
  const server = createAppServer({ analyticsEnabled: false });
  const origin = await listen(server, t);

  const response = await fetch(`${origin}/api/traffic-stats`);

  assert.equal(response.status, 404);
});

test("traffic analytics counts successful page views and daily visitors", async (t) => {
  const records = [];
  const server = createAppServer({
    analyticsEnabled: true,
    logger: captureLogger(records),
    trafficAnalyticsOptions: {
      clock: () => new Date("2026-09-13T12:00:00.000Z"),
      salt: "test-salt",
    },
  });
  const origin = await listen(server, t);

  const firstVisitor = {
    "user-agent": "analytics-test-a",
    "x-forwarded-for": "203.0.113.10",
  };
  const secondVisitor = {
    "user-agent": "analytics-test-b",
    "x-forwarded-for": "203.0.113.10",
  };
  assert.equal((await fetch(`${origin}/?source=test`, {
    headers: firstVisitor,
  })).status, 200);
  assert.equal((await fetch(`${origin}/index.html`, {
    headers: firstVisitor,
  })).status, 200);
  assert.equal((await fetch(`${origin}/`, {
    headers: secondVisitor,
  })).status, 200);
  assert.equal((await fetch(`${origin}/`, {
    method: "HEAD",
    headers: secondVisitor,
  })).status, 200);

  const response = await fetch(`${origin}/api/traffic-stats`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    day: "2026-09-13",
    pv: 3,
    uv: 2,
  });
  assert.deepEqual(
    records
      .filter((record) => record.event === "traffic_analytics")
      .map(({ day, pv, uv, new_visitor: newVisitor }) => ({
        day,
        pv,
        uv,
        newVisitor,
      })),
    [
      { day: "2026-09-13", pv: 1, uv: 1, newVisitor: true },
      { day: "2026-09-13", pv: 2, uv: 1, newVisitor: false },
      { day: "2026-09-13", pv: 3, uv: 2, newVisitor: true },
    ],
  );
});
