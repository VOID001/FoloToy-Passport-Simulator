import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createAppServer } from "../server.mjs";

test("HTML does not restrict iframe parent origins", async (t) => {
  const server = createAppServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const pathname of ["/", "/?play=100", "/index.html?play=100"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${origin}${pathname}`, { method });
      assert.equal(response.status, 200);
      const policy = response.headers.get("content-security-policy");
      const ancestors = policy.split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("frame-ancestors "));
      assert.equal(ancestors, undefined);
      // Neither response header should restrict the embedding parent.
      assert.equal(response.headers.get("x-frame-options"), null);
      assert.match(policy, /script-src 'self' 'wasm-unsafe-eval';/);
      assert.match(policy, /connect-src 'self';/);
      assert.equal(response.headers.get("cross-origin-embedder-policy"), "require-corp");
      assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
      assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("permissions-policy"), "camera=(), geolocation=(), serial=()");
      await response.arrayBuffer();
    }
  }
});
