import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  type DesktopStreamEvent,
  sendDesktopMessageSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import {
  LOCAL_TOOL_DEFINITIONS,
  executeLocalTool,
  summariseToolCall,
} from "../lib/local-tools.js";
import { logger } from "../lib/logger.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import type { ControllerBindings } from "../types.js";

const DESKTOP_CHANNEL_TYPE = "desktop";
const DESKTOP_SESSION_PREFIX = "desktop-";
const HISTORY_MESSAGE_LIMIT = 40;
const MAX_TOOL_ROUNDTRIPS = 6;

// Module-scoped encoder — TextEncoder is a value binding in @types/node
// (no DOM lib is loaded in controller tsconfig), so it cannot be used as a
// type parameter. Keeping the instance here avoids any type-vs-value dance.
const sseEncoder = new TextEncoder();

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAiToolCall[];
}

interface ResolvedProvider {
  botId: string;
  providerKey: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  extraHeaders: Record<string, string> | undefined;
  systemPrompt: string | null;
}

interface StreamAccumulator {
  text: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  streamError: string | null;
}

function buildOpenAiCompatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/chat/completions`;
}

function toStringHeaderRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function extractCompatMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts = content.flatMap((part) => {
    if (typeof part !== "object" || part === null) {
      return [];
    }
    const block = part as Record<string, unknown>;
    if (
      (block.type === "text" || block.type === "replyContext") &&
      typeof block.text === "string"
    ) {
      return [block.text];
    }
    return [];
  });
  return parts.join("\n").trim();
}

function generateDesktopSessionKey(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${DESKTOP_SESSION_PREFIX}${Date.now().toString(36)}-${random}`;
}

/**
 * Root folder that holds one sub-directory per conversation. Lives under the
 * user's home directory so files a chat produces are easy to browse (and can
 * be opened directly from the "Open workspace" task action).
 */
const WORKSPACE_ROOT_DIR_NAME = "Lingguang";
const WORKSPACE_CONVERSATIONS_DIR_NAME = "conversations";

/**
 * Sanitise a session key into something safe to use as a single path segment
 * (session keys are already URL-safe, but guard against separators just in
 * case a custom key is supplied).
 */
function sanitizeWorkspaceSegment(sessionKey: string): string {
  const cleaned = sessionKey.replace(/[^a-zA-Z0-9._-]/gu, "-");
  return cleaned.length > 0 ? cleaned : "default";
}

/**
 * Compute (and create) the per-conversation workspace directory. Returns the
 * absolute path, or null if the directory could not be created — callers then
 * fall back to the previous shared-directory behaviour.
 */
async function ensureWorkspaceDir(sessionKey: string): Promise<string | null> {
  const dir = path.join(
    homedir(),
    WORKSPACE_ROOT_DIR_NAME,
    WORKSPACE_CONVERSATIONS_DIR_NAME,
    sanitizeWorkspaceSegment(sessionKey),
  );
  try {
    await mkdir(dir, { recursive: true });
    return dir;
  } catch (error) {
    logger.warn(
      {
        route: "desktopChat.messages",
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      },
      "failed to create conversation workspace directory",
    );
    return null;
  }
}

function deriveTitleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "Desktop chat";
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

function encodeSse(event: DesktopStreamEvent): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Resolve the bot + provider entirely from the controller-owned config store.
 * This lets desktop chat work on a fresh install (no openclaw.json needed —
 * we create a default bot on demand) and returns everything needed to talk
 * to the OpenAI-compatible upstream directly.
 */
async function resolveProvider(
  container: ControllerContainer,
  requestedBotId: string | undefined,
): Promise<ResolvedProvider | { error: string }> {
  let bot = requestedBotId
    ? await container.configStore.getBot(requestedBotId)
    : null;
  if (!bot) {
    // First-install path: automatically provision a default bot so the user
    // can send a message without visiting any setup page first.
    bot = await container.configStore.getOrCreateDefaultBot();
  }

  const rawModel = bot.modelId;
  if (!rawModel || !rawModel.includes("/")) {
    return {
      error:
        "The default bot has no model configured. Open the Models page and configure a BYOK provider (OpenAI, DeepSeek, Gemini, …) first.",
    };
  }

  const config = await container.configStore.getConfig();
  const configuredProviders = config.models?.providers ?? {};

  // A model id has the form `{providerKey}/{modelId}`. Most provider keys are
  // a single segment (e.g. "openai"), but custom providers are stored under a
  // TWO-segment key like "custom-openai/getjob" (templateId/instanceId). So a
  // model id like "custom-openai/getjob/getjob" must NOT be split at the first
  // slash. Resolve by finding the configured provider key that is the longest
  // prefix of the model id (followed by "/").
  const providerKey =
    Object.keys(configuredProviders)
      .filter(
        (key) => rawModel === key || rawModel.startsWith(`${key}/`),
      )
      .sort((left, right) => right.length - left.length)[0] ??
    // Fall back to the naive first-segment split when nothing matches (keeps
    // the original behaviour for single-segment providers not yet in config).
    rawModel.slice(0, rawModel.indexOf("/"));
  const modelId = rawModel.startsWith(`${providerKey}/`)
    ? rawModel.slice(providerKey.length + 1)
    : rawModel;

  const provider = configuredProviders[providerKey];
  if (!provider?.baseUrl) {
    return {
      error: `The bot points at model "${rawModel}", but provider "${providerKey}" is not configured. Open the Models page and configure it with your API key.`,
    };
  }
  if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) {
    return {
      error: `Provider "${providerKey}" has no API key. Open the Models page and paste your key, or pick a different provider.`,
    };
  }
  if (provider.api !== "openai-completions") {
    return {
      error: `Provider "${providerKey}" uses the "${provider.api}" API, which desktop chat does not support yet. Please switch to an OpenAI-compatible provider (OpenAI, DeepSeek, Gemini, Groq, Together, …).`,
    };
  }

  return {
    botId: bot.id,
    providerKey,
    modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    api: provider.api,
    extraHeaders: toStringHeaderRecord(provider.headers),
    systemPrompt: bot.systemPrompt?.trim().length ? bot.systemPrompt : null,
  };
}

async function loadHistoryMessages(
  container: ControllerContainer,
  botId: string,
  sessionKey: string,
): Promise<OpenAiChatMessage[]> {
  const history = await container.sessionService.getChatHistoryBySessionKey(
    botId,
    sessionKey,
    HISTORY_MESSAGE_LIMIT,
  );
  const messages: OpenAiChatMessage[] = [];
  for (const message of history.messages) {
    const content = extractCompatMessageText(message.content);
    if (!content) {
      continue;
    }
    messages.push({ role: message.role, content });
  }
  return messages;
}

/**
 * Perform one round-trip against the OpenAI-compatible provider, streaming
 * text deltas to the SSE controller as they arrive and accumulating any
 * tool_calls the model wants us to execute.
 */
async function streamOneRound(params: {
  resolved: ResolvedProvider;
  messages: OpenAiChatMessage[];
  sseController: ReadableStreamDefaultController<Uint8Array>;
}): Promise<StreamAccumulator> {
  const accumulator: StreamAccumulator = {
    text: "",
    toolCalls: [],
    finishReason: null,
    streamError: null,
  };

  const upstream = await proxyFetch(
    buildOpenAiCompatUrl(params.resolved.baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.resolved.apiKey}`,
        ...(params.resolved.extraHeaders ?? {}),
      },
      body: JSON.stringify({
        model: params.resolved.modelId,
        messages: params.messages,
        stream: true,
        tools: LOCAL_TOOL_DEFINITIONS,
        tool_choice: "auto",
      }),
    },
  );

  if (!upstream.ok || !upstream.body) {
    const errorText = await upstream.text();
    accumulator.streamError =
      errorText.trim().length > 0
        ? errorText.slice(0, 500)
        : `Upstream model provider failed (status ${upstream.status})`;
    return accumulator;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  const drainDataLine = (data: string): void => {
    if (!data || data === "[DONE]") {
      return;
    }
    try {
      const parsed = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
      };
      const choice = parsed.choices?.[0];
      if (!choice) {
        return;
      }
      const delta = choice.delta;
      if (delta?.content) {
        accumulator.text += delta.content;
        params.sseController.enqueue(
          encodeSse({ type: "delta", text: delta.content }),
        );
      }
      if (delta?.tool_calls) {
        for (const partial of delta.tool_calls) {
          const idx = partial.index ?? 0;
          const existing = accumulator.toolCalls[idx];
          if (!existing) {
            accumulator.toolCalls[idx] = {
              id: partial.id ?? `call_${idx}`,
              type: "function",
              function: {
                name: partial.function?.name ?? "",
                arguments: partial.function?.arguments ?? "",
              },
            };
          } else {
            if (partial.id) {
              existing.id = partial.id;
            }
            if (partial.function?.name) {
              existing.function.name = partial.function.name;
            }
            if (partial.function?.arguments) {
              existing.function.arguments += partial.function.arguments;
            }
          }
        }
      }
      if (choice.finish_reason) {
        accumulator.finishReason = choice.finish_reason;
      }
    } catch {
      // Ignore malformed SSE chunks from upstream providers.
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
      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) {
          continue;
        }
        drainDataLine(line.slice(6).trim());
      }
    }
    const trailing = sseBuffer.trim();
    if (trailing.startsWith("data: ")) {
      drainDataLine(trailing.slice(6).trim());
    }
  } catch (error) {
    accumulator.streamError = `stream error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // reader may already be released
    }
  }

  // Filter out any empty tool-call slots that never received a name — this
  // happens when providers emit sparse indices.
  accumulator.toolCalls = accumulator.toolCalls.filter(
    (tc) => tc && tc.function.name.length > 0,
  );
  return accumulator;
}

function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function registerDesktopChatRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/desktop-chat/messages",
      tags: ["Desktop Chat"],
      request: {
        body: {
          content: {
            "application/json": { schema: sendDesktopMessageSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "text/event-stream": { schema: z.string() },
          },
          description:
            "Server-sent event stream of {type: session|delta|toolCall|done|error} JSON payloads",
        },
        400: {
          content: {
            "application/json": { schema: z.object({ error: z.string() }) },
          },
          description: "Bad request or misconfigured model provider",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const resolved = await resolveProvider(container, body.botId);
      if ("error" in resolved) {
        return c.json({ error: resolved.error }, 400);
      }

      const trimmedSessionKey = body.sessionKey?.trim() ?? "";
      const isNewSession = trimmedSessionKey.length === 0;
      const sessionKey = isNewSession
        ? generateDesktopSessionKey()
        : trimmedSessionKey;
      const providedTitle = body.title?.trim() ?? "";
      const derivedTitle = deriveTitleFromText(body.text);

      // On follow-up messages preserve the existing session title so we don't
      // rewrite it with every user turn.
      let existingTitle = "";
      if (!isNewSession) {
        const sessionList = await container.sessionService.listSessions({
          limit: 100,
          offset: 0,
          botId: resolved.botId,
          channelType: DESKTOP_CHANNEL_TYPE,
        });
        existingTitle =
          sessionList.sessions.find(
            (session) => session.sessionKey === sessionKey,
          )?.title ?? "";
      }

      const persistTitle =
        providedTitle.length > 0
          ? providedTitle
          : existingTitle.length > 0
            ? existingTitle
            : derivedTitle;

      // Each conversation gets its own workspace folder so the files a chat
      // produces are grouped together and can be opened from the task list.
      const workspaceDir = await ensureWorkspaceDir(sessionKey);

      const historyMessages: OpenAiChatMessage[] = isNewSession
        ? []
        : await loadHistoryMessages(container, resolved.botId, sessionKey);
      const outgoing: OpenAiChatMessage[] = [];
      if (resolved.systemPrompt) {
        outgoing.push({ role: "system", content: resolved.systemPrompt });
      }
      if (workspaceDir) {
        outgoing.push({
          role: "system",
          content:
            `This conversation has a dedicated workspace directory at: ${workspaceDir}\n` +
            "When you create files for the user, write them here (run_command runs in this directory by default). " +
            "Use get_workspace_directory if you need the absolute path.",
        });
      }
      outgoing.push(...historyMessages);
      outgoing.push({ role: "user", content: body.text });

      const localToolOptions = workspaceDir ? { workspaceDir } : undefined;

      const stream = new ReadableStream<Uint8Array>({
        async start(sseController) {
          sseController.enqueue(
            encodeSse({
              type: "session",
              botId: resolved.botId,
              sessionKey,
              title: persistTitle,
            }),
          );

          const runningMessages: OpenAiChatMessage[] = [...outgoing];
          let assistantText = "";
          let streamError: string | null = null;

          for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round += 1) {
            const result = await streamOneRound({
              resolved,
              messages: runningMessages,
              sseController,
            });
            assistantText += result.text;

            if (result.streamError) {
              streamError = result.streamError;
              sseController.enqueue(
                encodeSse({ type: "error", message: result.streamError }),
              );
              break;
            }

            if (result.toolCalls.length === 0) {
              break;
            }

            // Reflect the assistant's tool-call turn in the running history
            // (OpenAI protocol expects the assistant "tool_calls" message
            // right before the tool result messages).
            runningMessages.push({
              role: "assistant",
              content: result.text.length > 0 ? result.text : null,
              tool_calls: result.toolCalls,
            });

            for (const toolCall of result.toolCalls) {
              const args = parseToolArgs(toolCall.function.arguments);
              const summary = summariseToolCall(toolCall.function.name, args);
              sseController.enqueue(
                encodeSse({
                  type: "toolCall",
                  name: toolCall.function.name,
                  summary,
                }),
              );
              logger.info(
                {
                  route: "desktopChat.messages",
                  botId: resolved.botId,
                  sessionKey,
                  toolName: toolCall.function.name,
                },
                "desktop chat tool call",
              );
              const execution = await executeLocalTool(
                toolCall.function.name,
                args,
                localToolOptions,
              );
              runningMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: execution.content,
              });
            }
            // Loop back for the next model turn with tool results in-context.
          }

          const trimmedAssistant = assistantText.trim();
          if (!streamError && trimmedAssistant.length > 0) {
            try {
              await container.sessionService.appendCompatTranscript({
                botId: resolved.botId,
                sessionKey,
                title: persistTitle,
                channelType: DESKTOP_CHANNEL_TYPE,
                channelId: null,
                metadata: {
                  source: "desktop-native-chat",
                  ...(workspaceDir ? { workspacePath: workspaceDir } : {}),
                },
                userText: body.text,
                assistantText: trimmedAssistant,
                provider: resolved.providerKey,
                model: resolved.modelId,
                api: resolved.api,
              });
            } catch (persistError) {
              logger.error(
                {
                  route: "desktopChat.messages",
                  botId: resolved.botId,
                  sessionKey,
                  error:
                    persistError instanceof Error
                      ? persistError.message
                      : String(persistError),
                },
                "desktop chat transcript persist failed",
              );
            }
          }

          sseController.enqueue(
            encodeSse({
              type: "done",
              provider: resolved.providerKey,
              model: resolved.modelId,
            }),
          );
          sseController.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    },
  );
}
