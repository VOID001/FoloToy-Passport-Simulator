import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { loadAnalytics } from "../public/analytics.js";
import {
  createAppServer,
  umamiAnalyticsConfig,
} from "../server.mjs";

const WEBSITE_ID = "123e4567-e89b-42d3-a456-426614174000";

test("Umami analytics requires the feature flag and a valid website ID", () => {
  assert.equal(umamiAnalyticsConfig({}), null);
  assert.equal(
    umamiAnalyticsConfig({
      EMULATOR_TRAFFIC_ANALYTICS: "1",
      UMAMI_WEBSITE_ID: "invalid",
    }),
    null,
  );
  assert.deepEqual(
    umamiAnalyticsConfig({
      EMULATOR_TRAFFIC_ANALYTICS: "1",
      UMAMI_WEBSITE_ID: WEBSITE_ID,
    }),
    {
      provider: "umami",
      websiteId: WEBSITE_ID,
    },
  );
});

test("runtime config exposes Umami configuration when enabled", async (t) => {
  const server = createAppServer({
    allowLocalFirmwareUpload: false,
    env: {
      EMULATOR_TRAFFIC_ANALYTICS: "1",
      UMAMI_WEBSITE_ID: WEBSITE_ID,
    },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/runtime-config`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    allowLocalFirmwareUpload: false,
    analytics: {
      provider: "umami",
      websiteId: WEBSITE_ID,
    },
  });
});

test("browser loader adds the Umami tracker once", () => {
  const appended = [];
  const documentRef = {
    querySelector: () => appended[0] || null,
    createElement: () => ({ dataset: {} }),
    head: {
      append: (element) => appended.push(element),
    },
  };
  const config = {
    provider: "umami",
    websiteId: WEBSITE_ID,
  };

  assert.equal(loadAnalytics(config, documentRef), true);
  assert.equal(loadAnalytics(config, documentRef), false);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, "umami-analytics");
  assert.equal(appended[0].defer, true);
  assert.equal(appended[0].crossOrigin, "anonymous");
  assert.equal(appended[0].src, "https://cloud.umami.is/script.js");
  assert.equal(appended[0].dataset.websiteId, WEBSITE_ID);
});
