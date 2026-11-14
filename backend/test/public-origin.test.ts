import assert from "node:assert/strict";
import { test } from "node:test";

import { publicCallbackOrigin } from "../src/services/public-origin";

test("provider callbacks require an HTTPS origin or local development origin", () => {
  assert.equal(publicCallbackOrigin("https://api.example.test/"), "https://api.example.test");
  assert.equal(publicCallbackOrigin("http://localhost:3000"), "http://localhost:3000");
  for (const invalid of [undefined, "http://api.example.test", "https://api.example.test/path", "https://user:password@api.example.test", "https://api.example.test/?x=1"]) {
    assert.throws(() => publicCallbackOrigin(invalid));
  }
});
