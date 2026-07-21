import type {
  CreateScheduledTaskInput,
  ScheduledTaskResponse,
  UpdateScheduledTaskInput,
} from "@nexu/shared";

/**
 * Raw-fetch client for the scheduled-tasks controller API. The generated
 * hey-api SDK is regenerated from the OpenAPI doc in CI; until that runs these
 * endpoints aren't in the SDK, so (like desktop-chat) we call them directly.
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

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = resolveApiBaseUrl();
  const response = await fetch(`${base}${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text.trim().length > 0) {
        message = text.slice(0, 500);
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function listScheduledTasks(): Promise<ScheduledTaskResponse[]> {
  const data = await requestJson<{ tasks: ScheduledTaskResponse[] }>(
    "/api/v1/scheduled-tasks",
  );
  return data.tasks ?? [];
}

export async function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<ScheduledTaskResponse> {
  return requestJson<ScheduledTaskResponse>("/api/v1/scheduled-tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateScheduledTask(
  id: string,
  input: UpdateScheduledTaskInput,
): Promise<ScheduledTaskResponse> {
  return requestJson<ScheduledTaskResponse>(
    `/api/v1/scheduled-tasks/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function deleteScheduledTask(
  id: string,
): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/v1/scheduled-tasks/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}

export async function runScheduledTask(id: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(
    `/api/v1/scheduled-tasks/${encodeURIComponent(id)}/run`,
    { method: "POST" },
  );
}
