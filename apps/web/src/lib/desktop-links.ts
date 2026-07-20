type HostInvokeBridge = {
  invoke: (
    channel: "shell:open-external",
    payload: { url: string },
  ) => Promise<{ ok: boolean }>;
};

function getHostInvokeBridge(): HostInvokeBridge | null {
  if (typeof window === "undefined") {
    return null;
  }

  const candidate = (window as Window & { nexuHost?: unknown }).nexuHost;
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const invoke = Reflect.get(candidate, "invoke");
  if (typeof invoke !== "function") {
    return null;
  }

  return {
    invoke: (channel, payload) =>
      invoke.call(candidate, channel, payload) as Promise<{ ok: boolean }>,
  };
}

function getSessionMetadataPath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) {
    return null;
  }

  const pathValue = metadata.path;
  return typeof pathValue === "string" && pathValue.trim().length > 0
    ? pathValue
    : null;
}

function getParentPath(filePath: string): string | null {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const match = normalized.match(/^(.*)[\\/][^\\/]+$/);
  return match?.[1] ?? null;
}

export function pathToFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized)}`;
}

function getSessionWorkspacePath(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) {
    return null;
  }

  const workspaceValue = metadata.workspacePath;
  return typeof workspaceValue === "string" &&
    workspaceValue.trim().length > 0
    ? workspaceValue
    : null;
}

export function getSessionFolderUrl(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  // Prefer the dedicated per-conversation workspace directory when present —
  // this is already a folder, so it can be opened directly.
  const workspacePath = getSessionWorkspacePath(metadata);
  if (workspacePath) {
    return pathToFileUrl(workspacePath);
  }

  // Legacy fallback: derive the parent folder of a stored file path.
  const filePath = getSessionMetadataPath(metadata);
  if (!filePath) {
    return null;
  }

  const folderPath = getParentPath(filePath);
  return folderPath ? pathToFileUrl(folderPath) : null;
}

function fileUrlToPath(fileUrl: string): string | null {
  if (!fileUrl.startsWith("file://")) {
    return null;
  }
  let raw = fileUrl.slice("file://".length);
  // Windows: file:///C:/... → C:/...
  if (/^\/[A-Za-z]:\//.test(raw)) {
    raw = raw.slice(1);
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export async function openLocalFolderUrl(url: string): Promise<void> {
  const hostBridge = getHostInvokeBridge();
  const folderPath = fileUrlToPath(url);
  if (folderPath) {
    try {
      const response = await fetch("/api/internal/desktop/shell-open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: folderPath }),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Fall back to the desktop bridge when the controller is unavailable.
    }

    if (hostBridge) {
      await hostBridge.invoke("shell:open-external", { url });
    }
    return;
  }

  if (hostBridge) {
    await hostBridge.invoke("shell:open-external", { url });
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  const hostBridge = getHostInvokeBridge();
  if (hostBridge) {
    await hostBridge.invoke("shell:open-external", { url });
    return;
  }

  window.open(url, "_blank", "noopener,noreferrer");
}
