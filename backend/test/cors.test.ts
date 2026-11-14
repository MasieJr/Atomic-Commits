import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { createApp } from "../src/app";

test("browser preflights allow only configured application origins", async (t) => {
  const { app, close } = createApp({ webAllowedOrigins: ["http://localhost:53211"] });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/offline-redemptions`;
  const preflight = (origin: string) => fetch(url, {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" },
  });
  const allowed = await preflight("http://localhost:53211");
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:53211");
  assert.match(allowed.headers.get("access-control-allow-headers") ?? "", /Idempotency-Key/i);
  const denied = await preflight("https://untrusted.example");
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});
