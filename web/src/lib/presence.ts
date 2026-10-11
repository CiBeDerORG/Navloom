export type ProbeSettings = { mode: "auto" | "manual"; intervalMs: number; updatedAt: number };

let wanted = false;
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/** Exactly one page-presence WebSocket per tab, independent of background visibility. */
export function setPresenceWanted(enabled: boolean): void {
  wanted = enabled;
  if (!enabled) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    const previous = socket;
    socket = null;
    previous?.close(1000, "page left");
    return;
  }
  if (socket || retryTimer) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const next = new WebSocket(scheme + "//" + location.host + "/api/v1/presence");
  socket = next;
  next.addEventListener("message", (event) => {
    try {
      const parsed = JSON.parse(String(event.data)) as { type?: string; settings?: ProbeSettings };
      if (parsed.type === "probe_settings" && parsed.settings &&
          ["auto", "manual"].includes(parsed.settings.mode) &&
          Number.isInteger(parsed.settings.intervalMs)) {
        window.dispatchEvent(new CustomEvent("navloom-probe-settings", { detail: parsed.settings }));
      }
    } catch { /* Ignore invalid Server event. */ }
  });
  next.addEventListener("close", () => {
    if (socket !== next) return;
    socket = null;
    if (!wanted) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      window.dispatchEvent(new Event("navloom-presence-recheck"));
    }, 3000);
  });
  next.addEventListener("error", () => {
    // onclose drives the authenticated reconnect check; never spin on auth failures.
  });
}
