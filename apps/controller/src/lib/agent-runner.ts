import type { ControllerContainer } from "../app/container.js";
import { buildLocalToolDefinitions, executeLocalTool } from "./local-tools.js";
import { logger } from "./logger.js";
import { proxyFetch } from "./proxy-fetch.js";

/**
 * Non-streaming agent executor used by the scheduler (and any future
 * "run once" caller). It mirrors the provider resolution + tool loop used by
 * the streaming desktop-chat route, but collects a single final text result
 * instead of emitting SSE events.
 */

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
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
  extraHeaders: Record<string, string> | undefined;
  systemPrompt: string | null;
}

const MAX_TOOL_ROUNDS = 5;

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

/**
 * Resolve a bot + its OpenAI-compatible provider from the config store.
 * Mirrors resolveProvider() in desktop-chat-routes.ts (kept standalone so the
 * scheduler doesn't depend on the SSE route module).
 */
async function resolveBotProvider(
  container: ControllerContainer,
  requestedBotId: string | null | undefined,
): Promise<ResolvedProvider | { error: string }> {
  let bot = requestedBotId
    ? await container.configStore.getBot(requestedBotId)
    : null;
  if (!bot) {
    bot = await container.configStore.getOrCreateDefaultBot();
  }

  const rawModel = bot.modelId;
  if (!rawModel || !rawModel.includes("/")) {
    return {
      error: "The bot has no model configured. Configure a provider first.",
    };
  }

  const config = await container.configStore.getConfig();
  const configuredProviders = config.models?.providers ?? {};

  const providerKey =
    Object.keys(configuredProviders)
      .filter((key) => rawModel === key || rawModel.startsWith(`${key}/`))
      .sort((left, right) => right.length - left.length)[0] ??
    rawModel.slice(0, rawModel.indexOf("/"));
  const modelId = rawModel.startsWith(`${providerKey}/`)
    ? rawModel.slice(providerKey.length + 1)
    : rawModel;

  const provider = configuredProviders[providerKey];
  if (!provider?.baseUrl) {
    return { error: `Provider "${providerKey}" is not configured.` };
  }
  if (typeof provider.apiKey !== "string" || provider.apiKey.length === 0) {
    return { error: `Provider "${providerKey}" has no API key.` };
  }
  if (provider.api !== "openai-completions") {
    return {
      error: `Provider "${providerKey}" uses "${provider.api}", which scheduled tasks do not support (need an OpenAI-compatible provider).`,
    };
  }

  return {
    botId: bot.id,
    providerKey,
    modelId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    extraHeaders: toStringHeaderRecord(provider.headers),
    systemPrompt: bot.systemPrompt?.trim().length ? bot.systemPrompt : null,
  };
}

interface CompletionRoundResult {
  text: string;
  toolCalls: OpenAiToolCall[];
  error: string | null;
}

async function callOnce(
  resolved: ResolvedProvider,
  messages: ChatMessage[],
  tools: ReturnType<typeof buildLocalToolDefinitions>,
): Promise<CompletionRoundResult> {
  const upstream = await proxyFetch(buildOpenAiCompatUrl(resolved.baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolved.apiKey}`,
      ...(resolved.extraHeaders ?? {}),
    },
    body: JSON.stringify({
      model: resolved.modelId,
      messages,
      stream: false,
      tools,
      tool_choice: "auto",
    }),
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    return {
      text: "",
      toolCalls: [],
      error:
        errorText.trim().length > 0
          ? errorText.slice(0, 500)
          : `Upstream model provider failed (status ${upstream.status})`,
    };
  }

  const data = (await upstream.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const message = data.choices?.[0]?.message ?? {};
  const text = typeof message.content === "string" ? message.content : "";
  const toolCalls: OpenAiToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
        .filter((tc) => tc.function?.name)
        .map((tc, index) => ({
          id: tc.id ?? `call_${index}`,
          type: "function" as const,
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          },
        }))
    : [];
  return { text, toolCalls, error: null };
}

export interface RunAgentResult {
  ok: boolean;
  text: string;
  error?: string;
}

/**
 * Run an instruction through the bot's model, executing any local tool calls
 * it requests, and return the final assistant text.
 */
export async function runAgentCompletion(params: {
  container: ControllerContainer;
  botId?: string | null;
  instruction: string;
  allowFileWrites?: boolean;
  workspaceDir?: string;
  maxRounds?: number;
}): Promise<RunAgentResult> {
  const resolved = await resolveBotProvider(
    params.container,
    params.botId ?? undefined,
  );
  if ("error" in resolved) {
    return { ok: false, text: "", error: resolved.error };
  }

  const allowFileWrites = params.allowFileWrites ?? false;
  const tools = buildLocalToolDefinitions(allowFileWrites);
  const toolOptions = {
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    allowFileWrites,
  };

  const messages: ChatMessage[] = [];
  if (resolved.systemPrompt) {
    messages.push({ role: "system", content: resolved.systemPrompt });
  }
  messages.push({ role: "user", content: params.instruction });

  const maxRounds = params.maxRounds ?? MAX_TOOL_ROUNDS;
  let finalText = "";

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await callOnce(resolved, messages, tools);
    if (result.error) {
      return { ok: false, text: finalText.trim(), error: result.error };
    }
    if (result.text) {
      finalText = result.text;
    }
    if (result.toolCalls.length === 0) {
      break;
    }

    messages.push({
      role: "assistant",
      content: result.text.length > 0 ? result.text : null,
      tool_calls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const args = parseToolArgs(toolCall.function.arguments);
      const execution = await executeLocalTool(
        toolCall.function.name,
        args,
        toolOptions,
      );
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: execution.content,
      });
    }
  }

  logger.info(
    { botId: resolved.botId, resultChars: finalText.length },
    "scheduled_task_agent_completion",
  );

  return { ok: true, text: finalText.trim() };
}
