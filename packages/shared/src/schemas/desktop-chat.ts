import { z } from "zod";

/**
 * Desktop native chat — request/event schemas.
 *
 * Desktop chat is a new nexu-native channel (channelType: "desktop") that lets
 * users talk to their configured agent directly inside the desktop UI without
 * connecting an external IM (Slack / Feishu / etc.). Messages flow:
 *   Web UI -> POST /api/v1/desktop-chat/messages
 *          -> controller resolves agent+model from openclaw config
 *          -> proxies to the configured OpenAI-compatible model provider
 *          -> streams SSE (`delta` events) back to Web UI
 *          -> on completion, transcript is appended to
 *             ~/.nexu/runtime/openclaw/state/agents/{botId}/sessions/{key}.jsonl
 *             so the session is visible under the standard /workspace/sessions
 *             list with channelType === "desktop".
 */

export const sendDesktopMessageSchema = z.object({
  /** Bot (agent) id to talk to. Falls back to the default bot when omitted. */
  botId: z.string().optional(),
  /**
   * Existing session key (returned by a previous `session` event). Omit or
   * leave empty to start a new desktop session.
   */
  sessionKey: z.string().optional(),
  /** User-visible session title. Only used when creating a new session. */
  title: z.string().max(500).optional(),
  /** User message text. */
  text: z.string().min(1).max(32_000),
});
export type SendDesktopMessageInput = z.infer<typeof sendDesktopMessageSchema>;

/**
 * SSE event union emitted by POST /api/v1/desktop-chat/messages.
 *
 * The stream ALWAYS emits a `session` event first (so the client knows which
 * botId / sessionKey to use for subsequent messages), then zero or more
 * `delta` / `toolCall` events, and finally either `done` or `error`.
 */
export const desktopStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session"),
    botId: z.string(),
    sessionKey: z.string(),
    title: z.string(),
  }),
  z.object({
    type: z.literal("delta"),
    text: z.string(),
  }),
  z.object({
    type: z.literal("toolCall"),
    name: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    type: z.literal("done"),
    provider: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("error"),
    message: z.string(),
  }),
]);
export type DesktopStreamEvent = z.infer<typeof desktopStreamEventSchema>;
