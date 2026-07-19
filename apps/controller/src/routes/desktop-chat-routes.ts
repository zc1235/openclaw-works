import { readFile } from "node:fs/promises";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  type DesktopStreamEvent,
  openclawConfigSchema,
  sendDesktopMessageSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import { logger } from "../lib/logger.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import type { ControllerBindings } from "../types.js";

const DESKTOP_CHANNEL_TYPE = "desktop";
const DESKTOP_SESSION_PREFIX = "desktop-";
const HISTORY_MESSAGE_LIMIT = 40;

// Module-scoped encoder — TextEncoder is a value binding in @types/node
// (no DOM lib is loaded in controller tsconfig), so it cannot be used as a
// type parameter. Keeping the instance here avoids any type-vs-value dance.
const sseEncoder = new TextEncoder();

type OpenAiCompatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
};

type ResolvedProvider = {
  agentId: string;
  botId: string;
  providerKey: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  extraHeaders?: Record<string, string> | undefined;
  systemPrompt: string | null;
};

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

function deriveTitleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return "Desktop chat";
  }
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}

async function resolveProvider(
  container: ControllerContainer,
  requestedBotId: string | undefined,
): Promise<ResolvedProvider | { error: string }> {
  const rawConfig = await readFile(container.env.openclawConfigPath, "utf8");
  const openclawConfig = openclawConfigSchema.parse(JSON.parse(rawConfig));

  const preferredAgent = requestedBotId
    ? openclawConfig.agents.list.find((agent) => agent.id === requestedBotId)
    : undefined;
  const agent =
    preferredAgent ??
    openclawConfig.agents.list.find((item) => item.default) ??
    openclawConfig.agents.list[0];
  if (!agent) {
    return { error: "No agent configured" };
  }

  const defaultsModel = openclawConfig.agents.defaults?.model;
  const rawModel =
    typeof agent.model === "string"
      ? agent.model
      : (agent.model?.primary ??
        (typeof defaultsModel === "string"
          ? defaultsModel
          : defaultsModel?.primary));

  if (!rawModel || !rawModel.includes("/")) {
    return { error: "No compatible model configured" };
  }

  const slashIndex = rawModel.indexOf("/");
  const providerKey = rawModel.slice(0, slashIndex);
  const modelId = rawModel.slice(slashIndex + 1);
  const provider = openclawConfig.models?.providers?.[providerKey];
  if (
    !provider?.baseUrl ||
    !provider.apiKey ||
    typeof provider.apiKey !== "string" ||
    provider.api !== "openai-completions"
  ) {
    return {
      error:
        "Configured model provider is not OpenAI-compatible or lacks a static API key",
    };
  }

  const bot = await container.configStore.getBot(agent.id);
  return {
    agentId: agent.id,
    botId: bot?.id ?? agent.id,
    providerKey,
    modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    api: provider.api,
    extraHeaders: toStringHeaderRecord(provider.headers),
    systemPrompt: bot?.systemPrompt?.trim().length ? bot.systemPrompt : null,
  };
}

async function loadHistoryMessages(
  container: ControllerContainer,
  botId: string,
  sessionKey: string,
): Promise<OpenAiCompatMessage[]> {
  const history = await container.sessionService.getChatHistoryBySessionKey(
    botId,
    sessionKey,
    HISTORY_MESSAGE_LIMIT,
  );
  const messages: OpenAiCompatMessage[] = [];
  for (const message of history.messages) {
    const content = extractCompatMessageText(message.content);
    if (!content) {
      continue;
    }
    messages.push({ role: message.role, content });
  }
  return messages;
}

function encodeSse(event: DesktopStreamEvent): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`);
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
      // rewrite it with every user turn. Look it up once so appendCompatTranscript
      // keeps a stable value.
      let existingTitle = "";
      if (!isNewSession) {
        const history =
          await container.sessionService.getChatHistoryBySessionKey(
            resolved.botId,
            sessionKey,
            1,
          );
        if (history.sessionKey) {
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
      }

      const persistTitle =
        providedTitle.length > 0
          ? providedTitle
          : existingTitle.length > 0
            ? existingTitle
            : derivedTitle;

      const historyMessages = isNewSession
        ? []
        : await loadHistoryMessages(container, resolved.botId, sessionKey);
      const outgoing: OpenAiCompatMessage[] = [];
      if (resolved.systemPrompt) {
        outgoing.push({ role: "system", content: resolved.systemPrompt });
      }
      outgoing.push(...historyMessages);
      outgoing.push({ role: "user", content: body.text });

      const upstream = await proxyFetch(buildOpenAiCompatUrl(resolved.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolved.apiKey}`,
          ...(resolved.extraHeaders ?? {}),
        },
        body: JSON.stringify({
          model: resolved.modelId,
          messages: outgoing,
          stream: true,
        }),
      });

      const decoder = new TextDecoder();

      if (!upstream.ok || !upstream.body) {
        const errorText = await upstream.text();
        const errorStream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encodeSse({
                type: "session",
                botId: resolved.botId,
                sessionKey,
                title: persistTitle,
              }),
            );
            controller.enqueue(
              encodeSse({
                type: "error",
                message:
                  errorText.trim().length > 0
                    ? errorText.slice(0, 500)
                    : `Upstream model provider failed (status ${upstream.status})`,
              }),
            );
            controller.close();
          },
        });
        return new Response(errorStream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        });
      }

      let assistantText = "";
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encodeSse({
              type: "session",
              botId: resolved.botId,
              sessionKey,
              title: persistTitle,
            }),
          );

          const reader = upstream.body?.getReader();
          if (!reader) {
            controller.enqueue(
              encodeSse({
                type: "error",
                message: "Upstream stream unavailable",
              }),
            );
            controller.close();
            return;
          }

          let sseBuffer = "";
          let streamFailed = false;

          const drainDataLine = (data: string): void => {
            if (!data || data === "[DONE]") {
              return;
            }
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                assistantText += delta;
                controller.enqueue(
                  encodeSse({ type: "delta", text: delta }),
                );
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
            streamFailed = true;
            controller.enqueue(
              encodeSse({
                type: "error",
                message: `stream error: ${error instanceof Error ? error.message : String(error)}`,
              }),
            );
            logger.error(
              {
                route: "desktopChat.messages",
                botId: resolved.botId,
                sessionKey,
                error: error instanceof Error ? error.message : String(error),
              },
              "desktop chat upstream stream failed",
            );
          } finally {
            try {
              reader.releaseLock();
            } catch {
              // reader may already be released
            }
          }

          const trimmedAssistant = assistantText.trim();
          if (!streamFailed && trimmedAssistant.length > 0) {
            try {
              await container.sessionService.appendCompatTranscript({
                botId: resolved.botId,
                sessionKey,
                title: persistTitle,
                channelType: DESKTOP_CHANNEL_TYPE,
                channelId: null,
                metadata: {
                  source: "desktop-native-chat",
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

          controller.enqueue(
            encodeSse({
              type: "done",
              provider: resolved.providerKey,
              model: resolved.modelId,
            }),
          );
          controller.close();
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
