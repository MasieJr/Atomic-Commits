import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import { createApp } from "../src/app";

test("a trusted loopback proxy preserves separate client rate limits and ignores forged leftmost addresses", async (t) => {
  const { app, close } = createApp({ trustProxyLoopback: true });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await close();
  });
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const request = (forwarded: string) => fetch(`http://127.0.0.1:${address.port}/api/auth/register`, {
    method: "POST", headers: { "x-forwarded-for": forwarded },
  });
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await request(`192.0.2.${i + 1}, 203.0.113.10`)).status, 503);
  }
  assert.equal((await request("192.0.2.100, 203.0.113.10")).status, 429);
  assert.equal((await request("192.0.2.100, 203.0.113.11")).status, 503);
});
