export type NativeState = {
  observedAt: string;
  accessibility: boolean;
  screenCapture: boolean;
  app: string;
  windowTitle: string;
};

let current: NativeState | null = null;
const permissionRequests: Array<"accessibility" | "screen"> = [];

export function setNativeState(input: Partial<NativeState>) {
  const observedAt = typeof input.observedAt === "string" ? input.observedAt : "";
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("原生状态时间无效。");
  current = {
    observedAt,
    accessibility: input.accessibility === true,
    screenCapture: input.screenCapture === true,
    app: String(input.app ?? "").replace(/[\r\n\0]/g, " ").slice(0, 160),
    windowTitle: String(input.windowTitle ?? "").replace(/[\r\n\0]/g, " ").slice(0, 500),
  };
  return current;
}

export function getNativeState(maxAgeMs = 15_000) {
  if (!current || Date.now() - Date.parse(current.observedAt) > maxAgeMs) return null;
  return current;
}

export function queueNativePermission(kind: "accessibility" | "screen") {
  if (!permissionRequests.includes(kind)) permissionRequests.push(kind);
}

export function takeNativePermissionRequest() {
  return permissionRequests.shift() ?? null;
}
