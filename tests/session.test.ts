import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrossSite, sameText, sessionToken } from "../lib/session";

test("session tokens depend on the passcode and never contain it", async () => {
  const token = await sessionToken("kitchen-1");
  assert.equal(token, await sessionToken("kitchen-1"));
  assert.notEqual(token, await sessionToken("kitchen-2"));
  assert.ok(!token.includes("kitchen-1"));
});

test("text comparison", () => {
  assert.equal(sameText("abc", "abc"), true);
  assert.equal(sameText("abc", "abd"), false);
  assert.equal(sameText("abc", "abcd"), false);
});

test("requests from another site are refused", () => {
  assert.equal(isCrossSite(null, "praxis.local:3100"), false);
  assert.equal(isCrossSite("http://praxis.local:3100", "praxis.local:3100"), false);
  assert.equal(isCrossSite("https://evil.example", "praxis.local:3100"), true);
  assert.equal(isCrossSite("not a url", "praxis.local:3100"), true);
});
