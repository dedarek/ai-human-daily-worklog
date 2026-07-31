import assert from "node:assert/strict";
import test from "node:test";
import { getNativeState, queueNativePermission, setNativeState, takeNativePermissionRequest } from "../src/nativeBridge.js";

test("native app state is sanitized, expires and carries one permission request", () => {
  const state = setNativeState({
    observedAt: new Date().toISOString(),
    accessibility: true,
    screenCapture: true,
    app: "Code\nFake",
    windowTitle: "Project\0Title",
  });
  assert.equal(state.app, "Code Fake");
  assert.equal(state.windowTitle, "Project Title");
  assert.equal(getNativeState()?.accessibility, true);
  assert.equal(getNativeState(-1), null);
  queueNativePermission("accessibility");
  queueNativePermission("screen");
  queueNativePermission("accessibility");
  assert.equal(takeNativePermissionRequest(), "accessibility");
  assert.equal(takeNativePermissionRequest(), "screen");
  assert.equal(takeNativePermissionRequest(), null);
});

test("native app state rejects invalid timestamps", () => {
  assert.throws(() => setNativeState({ observedAt: "not-a-date" }), /时间无效/);
});
