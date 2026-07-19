import type { DesktopStreamEvent, SendDesktopMessageInput } from "@nexu/shared";

/**
 * Resolve the controller base URL the same way `apps/web/src/lib/api.ts`
 * configures the generated hey-api client. In packaged Electron this is
 * empty (same-origin loopback); in dev it's the value of VITE_API_BASE_URL.
 */
function resolveApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  const isElectronRenderer =
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Electron");
  if (isElectronRenderer) {
    return "";
  }
  return (configured ?? "").replace(/\/+$/u, "");
}

/**
 * Consume the SSE stream from POST /api/v1/desktop-chat/messages.
 *
 * The generated hey-api SDK doesn't cover streaming response bodies, so this
 * is the single sanctioned raw-fetch call for the desktop chat feature.
 */
export async function streamDesktopChat(
  body: SendDesktopMessageInput,
  handlers: {
    onEvent: (event: DesktopStreamEvent) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const baseUrl = resolveApiBaseUrl();
  const url = `${baseUrl}/api/v1/desktop-chat/messages`;

  const response = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!response.ok || !response.body) {
    let message = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text.trim().length > 0) {
        message = text.slice(0, 500);
      }
    } catch {
      // ignore
    }
    handlers.onEvent({ type: "error", message });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatchLine = (line: string): void => {
    if (!line.startsWith("data: ")) {
      return;
    }
    const payload = line.slice(6).trim();
    if (payload.length === 0) {
      return;
    }
    try {
      const parsed = JSON.parse(payload) as DesktopStreamEvent;
      handlers.onEvent(parsed);
    } catch {
      // Ignore malformed SSE chunks; upstream may buffer partial JSON.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        dispatchLine(line);
      }
    }
    const trailing = buffer.trim();
    if (trailing.length > 0) {
      dispatchLine(trailing);
    }
  } catch (error) {
    if (
      error instanceof DOMException &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      return;
    }
    handlers.onEvent({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
  }
}
