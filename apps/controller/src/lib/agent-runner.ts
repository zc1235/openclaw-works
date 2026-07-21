import type { ControllerContainer } from "../app/container.js";
import { buildLocalToolDefinitions, executeLocalTool } from "./local-tools.js";
import { logger } from "./logger.js";
import { proxyFetch } from "./proxy-fetch.js";

/**
 * Non-streaming agent executor used by scheduled tasks and desktop-chat
 * subagents. It deliberately exposes only the local filesystem tools: callers
 * that orchestrate work remain responsible for their own higher-level tools.
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

export interface ResolvedModelProvider {
  botId: string;
  providerKey: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  api: string;
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
 * Resolve a bot and configured OpenAI-compatible model. `modelId` is the full
 * configured identifier (`providerKey/modelId`) and, when supplied, lets a
 * desktop-chat parent choose a different configured model for a subagent.
 */
export async function resolveModelProvider(
  container: ControllerContainer,
  params: { botId?: string | null; modelId?: string | null },
): Promise<ResolvedModelProvider | { error: string }> {
  let bot = params.botId
    ? await container.configStore.getBot(params.botId)
    : null;
  if (!bot) {
    bot = await container.configStore.getOrCreateDefaultBot();
  }

  const rawModel = params.modelId?.trim() || bot.modelId;
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
  if (
    params.modelId?.trim() &&
    provider.models.length > 0 &&
    !provider.models.some((model) => model.id === modelId)
  ) {
    return {
      error: `Model "${params.modelId}" is not enabled for provider "${providerKey}". Choose a configured model or omit the override to inherit the parent model.`,
    };
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
    api: provider.api,
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
  resolved: ResolvedModelProvider,
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
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
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
        .filter((toolCall) => toolCall.function?.name)
        .map((toolCall, index) => ({
          id: toolCall.id ?? `call_${index}`,
          type: "function" as const,
          function: {
            name: toolCall.function?.name ?? "",
            arguments: toolCall.function?.arguments ?? "",
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
 * Run an instruction through a selected model, executing only local tool calls
 * it requests, and return its final assistant text. It cannot recursively
 * invoke desktop-chat orchestration tools.
 */
export async function runAgentCompletion(params: {
  container: ControllerContainer;
  botId?: string | null;
  /** Optional full configured `providerKey/modelId` override. */
  modelId?: string | null;
  instruction: string;
  /** System instructions added after the bot prompt, for focused child work. */
  additionalSystemPrompt?: string;
  allowFileWrites?: boolean;
  workspaceDir?: string;
  maxRounds?: number;
}): Promise<RunAgentResult> {
  const resolved = await resolveModelProvider(params.container, {
    botId: params.botId,
    modelId: params.modelId,
  });
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
  if (params.additionalSystemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: params.additionalSystemPrompt.trim(),
    });
  }
  messages.push({ role: "user", content: params.instruction });

  const maxRounds = params.maxRounds ?? MAX_TOOL_ROUNDS;
  let finalText = "";
  let exhaustedWithToolCall = false;

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await callOnce(resolved, messages, tools);
    if (result.error) {
      return { ok: false, text: finalText.trim(), error: result.error };
    }
    if (result.text) {
      finalText = result.text;
    }
    if (result.toolCalls.length === 0) {
      exhaustedWithToolCall = false;
      break;
    }
    exhaustedWithToolCall = round === maxRounds - 1;

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

  if (exhaustedWithToolCall) {
    messages.push({
      role: "system",
      content:
        "Your tool-call budget is exhausted. Do not request more tools. Give a concise final report of completed work, remaining work, and any relevant paths or results.",
    });
    const summary = await callOnce(resolved, messages, []);
    if (summary.error) {
      return { ok: false, text: finalText.trim(), error: summary.error };
    }
    if (summary.text.trim()) {
      finalText = summary.text;
    }
  }

  logger.info(
    {
      botId: resolved.botId,
      model: `${resolved.providerKey}/${resolved.modelId}`,
      resultChars: finalText.length,
    },
    "scheduled_task_agent_completion",
  );

  return { ok: true, text: finalText.trim() };
}
