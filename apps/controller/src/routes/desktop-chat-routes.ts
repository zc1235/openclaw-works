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
  type OpenAiToolDefinition,
  buildLocalToolDefinitions,
  executeLocalTool,
  summariseToolCall,
} from "../lib/local-tools.js";
import {
  type RunAgentResult,
  runAgentCompletion,
} from "../lib/agent-runner.js";
import { logger } from "../lib/logger.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import type { ControllerBindings } from "../types.js";

const DESKTOP_CHANNEL_TYPE = "desktop";
const DESKTOP_SESSION_PREFIX = "desktop-";
const HISTORY_MESSAGE_LIMIT = 40;
const MAX_TOOL_ROUNDTRIPS = 200;
const MAX_SUBAGENTS = 4;
const MAX_SUBAGENTS_PER_TURN = 4;
const MAX_SUBAGENT_TOOL_ROUNDS = 20;
const MAX_SUBAGENT_RESULT_CHARS = 16_000;

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
  reasoning: string;
  toolCalls: OpenAiToolCall[];
  finishReason: string | null;
  streamError: string | null;
}

interface DelegatedSubagentTask {
  id: string;
  task: string;
  instruction: string;
  model: string;
}

interface SubagentTrace {
  id: string;
  task: string;
  model: string;
  status: "completed" | "failed";
  result?: string;
  error?: string;
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

/**
 * Build a system message that tells the model where installed skills live and
 * which ones are available, so it can actually find and use them instead of
 * claiming it lacks the capability. Skills are folders (named by slug) with a
 * SKILL.md documenting how to run them.
 */
function buildInstalledSkillsSystemPrompt(
  container: ControllerContainer,
): string | null {
  let installedSlugs: string[] = [];
  try {
    const catalog = container.skillhubService.catalog.getCatalog();
    installedSlugs = [
      ...new Set(
        (catalog.installedSkills ?? [])
          .map((skill) => skill.slug)
          .filter((slug): slug is string => Boolean(slug)),
      ),
    ];
  } catch {
    installedSlugs = [];
  }

  const skillsDir = container.env.openclawSkillsDir;
  const userSkillsDir = container.env.userSkillsDir;
  const dirs = [skillsDir, userSkillsDir].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );
  if (dirs.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push(
    "Installed skills are capabilities the user enabled. Each is a folder (named by its slug) containing a SKILL.md that documents what it does and exactly how to run it (often scripts you execute with node or python). Skill folders live under:",
  );
  for (const dir of dirs) {
    lines.push(`- ${dir}`);
  }
  if (installedSlugs.length > 0) {
    lines.push(`Currently installed skills: ${installedSlugs.join(", ")}.`);
  } else {
    lines.push("No skills appear to be installed yet.");
  }
  lines.push(
    "When the user asks to use a skill, DO NOT claim you lack that capability. First locate its folder (use list_directory on the skill directories above and match the requested name to a slug), then read that folder's SKILL.md with read_file and follow its instructions (run any scripts via run_command). Only say a skill is unavailable after checking these directories and finding no matching folder.",
  );
  return lines.join("\n");
}

/**
 * Main-agent-only orchestration tool. Child agents run through the generic
 * runner, whose tool set intentionally excludes this definition, preventing
 * recursive fan-out.
 */
const DELEGATE_TO_SUBAGENTS_TOOL: OpenAiToolDefinition = {
  type: "function",
  function: {
    name: "delegate_to_subagents",
    description:
      "Delegate 2 to 4 independent, non-overlapping workstreams to focused subagents that run in parallel. Use this only when parallel work materially helps. Each subagent returns a deliverable for you to verify and synthesize into the final user answer.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description:
            "Two to four self-contained tasks. Omit model to inherit your configured model; otherwise use a configured full providerKey/modelId identifier.",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "Stable short identifier for this subagent.",
              },
              task: {
                type: "string",
                description: "Short description shown to the user.",
              },
              instruction: {
                type: "string",
                description:
                  "Complete, self-contained implementation or research instruction for the child.",
              },
              model: {
                type: "string",
                description:
                  "Optional configured full providerKey/modelId identifier. Omit to inherit the parent model.",
              },
            },
            required: ["task", "instruction"],
            additionalProperties: false,
          },
          minItems: 2,
          maxItems: MAX_SUBAGENTS,
        },
      },
      required: ["tasks"],
      additionalProperties: false,
    },
  },
};

function buildDelegationSystemPrompt(
  inheritedModel: string,
  configuredModels: string[],
): string {
  const listedModels = configuredModels.slice(0, 80);
  const availableModels =
    listedModels.length > 0
      ? listedModels.join(", ")
      : "No alternate configured model inventory is available; omit model to inherit.";
  return [
    "You can delegate large tasks with independent workstreams using delegate_to_subagents.",
    "Use it only when parallel work materially improves the result. Give each child a self-contained, non-overlapping instruction and do not delegate trivial or sequential work.",
    "Pass two to four tasks and make only one delegation call per user turn (at most four children total). Omit a child model to inherit your model, or set model to one of the configured full providerKey/modelId identifiers. Your current inherited model is " +
      inheritedModel +
      ".",
    "Available configured child models: " + availableModels + ".",
    "Children use dedicated workspace folders and return reports to you. After their reports arrive, you must assess and synthesize them into a single final answer for the user; do not merely repeat raw child output.",
  ].join("\n");
}

function truncateSubagentResult(text: string): string {
  if (text.length <= MAX_SUBAGENT_RESULT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_SUBAGENT_RESULT_CHARS)}\n\n[Subagent result truncated for parent context.]`;
}

function parseDelegatedSubagentTasks(
  args: Record<string, unknown>,
  inheritedModel: string,
): DelegatedSubagentTask[] | { error: string } {
  const rawTasks = args.tasks;
  if (!Array.isArray(rawTasks) || rawTasks.length < 2) {
    return { error: "delegate_to_subagents requires between 2 and 4 tasks." };
  }
  if (rawTasks.length > MAX_SUBAGENTS) {
    return { error: `delegate_to_subagents supports at most ${MAX_SUBAGENTS} tasks.` };
  }

  const usedIds = new Set<string>();
  const tasks: DelegatedSubagentTask[] = [];
  for (const [index, rawTask] of rawTasks.entries()) {
    if (typeof rawTask !== "object" || rawTask === null) {
      return { error: `Task ${index + 1} must be an object.` };
    }
    const record = rawTask as Record<string, unknown>;
    const task = typeof record.task === "string" ? record.task.trim() : "";
    const instruction =
      typeof record.instruction === "string" ? record.instruction.trim() : "";
    const requestedId =
      typeof record.id === "string" ? record.id.trim() : `subagent-${index + 1}`;
    const id = sanitizeWorkspaceSegment(requestedId).slice(0, 80);
    const requestedModel =
      typeof record.model === "string" ? record.model.trim() : "";
    if (!task || !instruction) {
      return { error: `Task ${index + 1} must include task and instruction.` };
    }
    if (!id || usedIds.has(id)) {
      return {
        error: `Task ${index + 1} needs a unique non-empty id.`,
      };
    }
    usedIds.add(id);
    tasks.push({
      id,
      task,
      instruction,
      model: requestedModel || inheritedModel,
    });
  }
  return tasks;
}

function subagentInstruction(task: DelegatedSubagentTask): string {
  return [
    "You are a focused subagent working for a parent agent.",
    "Complete only the assigned workstream below. Do not delegate, do not start unrelated work, and do not ask the user questions; make reasonable implementation decisions and state any assumptions.",
    "Your workspace is a dedicated folder separate from other subagents' default working directories. Use its local tools as needed. End with a concise, concrete deliverable report for the parent: completed work, key findings, paths/results, and remaining blockers.",
    `Assigned workstream (${task.task}):`,
    task.instruction,
  ].join("\n\n");
}

async function listConfiguredModelIds(
  container: ControllerContainer,
): Promise<string[]> {
  const config = await container.configStore.getConfig();
  const providers = config.models?.providers ?? {};
  return Array.from(
    new Set(
      Object.entries(providers).flatMap(([providerKey, provider]) =>
        provider.models
          .map((model) => model.id.trim())
          .filter((modelId) => modelId.length > 0)
          .map((modelId) => `${providerKey}/${modelId}`),
      ),
    ),
  );
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
  tools: OpenAiToolDefinition[];
  sseController: ReadableStreamDefaultController<Uint8Array>;
}): Promise<StreamAccumulator> {
  const accumulator: StreamAccumulator = {
    text: "",
    reasoning: "",
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
        // Only advertise tools when we have any. An empty tools array with
        // tool_choice:"auto" is rejected by some providers, and we use a
        // tools-less final round to force a plain-text summary.
        ...(params.tools.length > 0
          ? { tools: params.tools, tool_choice: "auto" }
          : {}),
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
            reasoning_content?: string;
            reasoning?: string;
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
      // Reasoning / chain-of-thought deltas (DeepSeek `reasoning_content`,
      // OpenRouter/others `reasoning`). Streamed as a distinct event so the UI
      // can render a collapsible "thinking" section separate from the answer.
      const reasoningChunk = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoningChunk) {
        accumulator.reasoning += reasoningChunk;
        params.sseController.enqueue(
          encodeSse({ type: "reasoning", text: reasoningChunk }),
        );
      }
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
            "Server-sent event stream of {type: session|delta|reasoning|toolCall|subagent|done|error} JSON payloads",
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
      const configuredModelIds = await listConfiguredModelIds(container);

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
            "Use get_workspace_directory if you need the absolute path.\n" +
            "A bundled Node.js and Python runtime are available via run_command (`node` and `python` are on PATH), " +
            "so you can write a script with write_file and run it to accomplish tasks (data processing, file " +
            "generation, calculations, automation, etc.). " +
            "Shell commands are NON-INTERACTIVE and cannot answer prompts: always use non-interactive flags " +
            "(e.g. `npm create vue@latest my-app -- --default`, `npm install`, `--yes`/`-y`). Prefer the write_file " +
            "tool over shell heredocs/echo for creating file contents. Work in small steps, and when the task is " +
            "complete, end with a short plain-text summary of what you did.",
        });
      }
      const skillsPrompt = buildInstalledSkillsSystemPrompt(container);
      if (skillsPrompt) {
        outgoing.push({ role: "system", content: skillsPrompt });
      }
      outgoing.push({
        role: "system",
        content: buildDelegationSystemPrompt(
          `${resolved.providerKey}/${resolved.modelId}`,
          configuredModelIds,
        ),
      });
      outgoing.push(...historyMessages);
      outgoing.push({ role: "user", content: body.text });

      // Sandbox mode (read-only) is opt-in. When off, the assistant may create
      // and modify files and run commands.
      const allowFileWrites =
        !(await container.configStore.getDesktopAgentSandbox());
      const toolDefinitions = [
        ...buildLocalToolDefinitions(allowFileWrites),
        DELEGATE_TO_SUBAGENTS_TOOL,
      ];
      const localToolOptions = {
        ...(workspaceDir ? { workspaceDir } : {}),
        allowFileWrites,
      };

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
          let assistantReasoning = "";
          const toolCallLog: Array<{ name: string; summary: string }> = [];
          const subagentLog: SubagentTrace[] = [];
          let delegatedSubagentCount = 0;
          let streamError: string | null = null;
          let sawFinalAnswer = false;

          for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round += 1) {
            const result = await streamOneRound({
              resolved,
              messages: runningMessages,
              tools: toolDefinitions,
              sseController,
            });
            assistantText += result.text;
            assistantReasoning += result.reasoning;

            if (result.streamError) {
              streamError = result.streamError;
              sseController.enqueue(
                encodeSse({ type: "error", message: result.streamError }),
              );
              break;
            }

            if (result.toolCalls.length === 0) {
              sawFinalAnswer = true;
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
              const isDelegation =
                toolCall.function.name === DELEGATE_TO_SUBAGENTS_TOOL.function.name;
              const summary = isDelegation
                ? `delegate_to_subagents: ${Array.isArray(args.tasks) ? args.tasks.length : 0} subagents`
                : summariseToolCall(toolCall.function.name, args);
              toolCallLog.push({ name: toolCall.function.name, summary });
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

              let toolResult: string;
              if (isDelegation) {
                const inheritedModel = `${resolved.providerKey}/${resolved.modelId}`;
                const parsedTasks = parseDelegatedSubagentTasks(
                  args,
                  inheritedModel,
                );
                if ("error" in parsedTasks) {
                  toolResult = `Unable to delegate: ${parsedTasks.error}`;
                } else if (
                  delegatedSubagentCount + parsedTasks.length >
                  MAX_SUBAGENTS_PER_TURN
                ) {
                  toolResult =
                    `Unable to delegate: this turn already used ${delegatedSubagentCount} of ` +
                    `${MAX_SUBAGENTS_PER_TURN} permitted subagents. Synthesize the reports already received instead.`;
                } else {
                  delegatedSubagentCount += parsedTasks.length;
                  // At most MAX_SUBAGENTS tasks are accepted, so Promise.all
                  // here is a deliberately bounded parallel worker pool.
                  const results = await Promise.all(
                    parsedTasks.map(async (task): Promise<SubagentTrace> => {
                      sseController.enqueue(
                        encodeSse({
                          type: "subagent",
                          id: task.id,
                          task: task.task,
                          model: task.model,
                          status: "started",
                        }),
                      );

                      let subagentWorkspace: string | undefined;
                      if (workspaceDir) {
                        subagentWorkspace = path.join(
                          workspaceDir,
                          "subagents",
                          task.id,
                        );
                        try {
                          await mkdir(subagentWorkspace, { recursive: true });
                        } catch (error) {
                          const message = `Could not create dedicated workspace: ${error instanceof Error ? error.message : String(error)}`;
                          sseController.enqueue(
                            encodeSse({
                              type: "subagent",
                              id: task.id,
                              task: task.task,
                              model: task.model,
                              status: "failed",
                              error: message,
                            }),
                          );
                          return {
                            id: task.id,
                            task: task.task,
                            model: task.model,
                            status: "failed",
                            error: message,
                          };
                        }
                      }

                      let child: RunAgentResult;
                      try {
                        child = await runAgentCompletion({
                          container,
                          botId: resolved.botId,
                          modelId: task.model,
                          instruction: subagentInstruction(task),
                          additionalSystemPrompt:
                            "This is a child execution. The parent agent handles orchestration and user communication; do not invoke any delegation mechanism.",
                          // Child writes are permitted only when it has an
                          // dedicated per-child workspace. This preserves the
                          // parent sandbox setting while avoiding ordinary
                          // relative-path file races.
                          allowFileWrites:
                            allowFileWrites && Boolean(subagentWorkspace),
                          workspaceDir: subagentWorkspace,
                          maxRounds: MAX_SUBAGENT_TOOL_ROUNDS,
                        });
                      } catch (error) {
                        const message = `Subagent execution failed: ${error instanceof Error ? error.message : String(error)}`;
                        sseController.enqueue(
                          encodeSse({
                            type: "subagent",
                            id: task.id,
                            task: task.task,
                            model: task.model,
                            status: "failed",
                            error: message,
                          }),
                        );
                        return {
                          id: task.id,
                          task: task.task,
                          model: task.model,
                          status: "failed",
                          error: message,
                        };
                      }
                      if (!child.ok) {
                        const error = child.error ?? "Subagent failed without an error message.";
                        sseController.enqueue(
                          encodeSse({
                            type: "subagent",
                            id: task.id,
                            task: task.task,
                            model: task.model,
                            status: "failed",
                            error,
                          }),
                        );
                        return {
                          id: task.id,
                          task: task.task,
                          model: task.model,
                          status: "failed",
                          error,
                        };
                      }

                      const report = truncateSubagentResult(child.text);
                      sseController.enqueue(
                        encodeSse({
                          type: "subagent",
                          id: task.id,
                          task: task.task,
                          model: task.model,
                          status: "completed",
                          result: report,
                        }),
                      );
                      return {
                        id: task.id,
                        task: task.task,
                        model: task.model,
                        status: "completed",
                        result: report,
                      };
                    }),
                  );
                  subagentLog.push(...results);
                  toolResult = JSON.stringify({ subagents: results });
                }
              } else {
                const execution = await executeLocalTool(
                  toolCall.function.name,
                  args,
                  localToolOptions,
                );
                toolResult = execution.content;
              }
              runningMessages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: toolResult,
              });
            }
            // Loop back for the next model turn with tool results in-context.
          }

          // If we exhausted the tool-call budget while the model still wanted
          // to keep going, don't just end silently — run one final tools-less
          // round so the model summarizes progress and tells the user it hit
          // the limit and can continue.
          if (!sawFinalAnswer && !streamError) {
            runningMessages.push({
              role: "system",
              content:
                `You have reached the maximum number of tool calls (${MAX_TOOL_ROUNDTRIPS}) allowed for a single turn. ` +
                "Do NOT request any more tools. In plain text, briefly summarize what you accomplished, what is still " +
                "unfinished, and ask the user whether you should continue.",
            });
            const summary = await streamOneRound({
              resolved,
              messages: runningMessages,
              tools: [],
              sseController,
            });
            assistantText += summary.text;
            assistantReasoning += summary.reasoning;
            if (summary.streamError || summary.text.trim().length === 0) {
              const notice = `\n\n[Reached the ${MAX_TOOL_ROUNDTRIPS}-tool-call limit for this turn. Send another message to have me continue.]`;
              sseController.enqueue(encodeSse({ type: "delta", text: notice }));
              assistantText += notice;
            }
          }

          const trimmedAssistant = assistantText.trim();
          const trimmedReasoning = assistantReasoning.trim();
          // Persist whenever the turn produced *any* assistant output — final
          // text OR tool activity. Agentic turns that are mostly tool calls
          // (e.g. "create a folder and scaffold a project") previously vanished
          // from history because they had little/no final text.
          if (
            !streamError &&
            (trimmedAssistant.length > 0 || toolCallLog.length > 0)
          ) {
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
                assistantReasoning:
                  trimmedReasoning.length > 0 ? trimmedReasoning : undefined,
                toolCalls: toolCallLog.length > 0 ? toolCallLog : undefined,
                subagents: subagentLog.length > 0 ? subagentLog : undefined,
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
