import { ChatMarkdown } from "@/components/ui/chat-markdown";
import { streamDesktopChat } from "@/lib/desktop-chat-stream";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, MessageSquarePlus, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  getApiV1Bots,
  getApiV1Sessions,
  getApiV1SessionsByIdMessages,
} from "../../lib/api/sdk.gen";

const BOT_AVATAR = "/brand/ip-nexu.svg";

interface StreamMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  error?: boolean;
}

interface DesktopSession {
  id: string;
  sessionKey: string;
  botId: string;
  title: string;
  updatedAt: string;
  lastMessageAt: string | null;
}

interface DesktopBot {
  id: string;
  name: string;
}

function stripMetadata(raw: string): string {
  const cleaned = raw
    .replace(
      /Conversation info \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/g,
      "",
    )
    .replace(
      /Sender \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/g,
      "",
    );
  const tsMatch = raw.match(
    /^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*([\s\S]*)$/,
  );
  if (tsMatch?.[1] != null) {
    return tsMatch[1].trim();
  }
  return cleaned.trim();
}

function extractText(msg: Record<string, unknown>): string {
  if (typeof msg.text === "string") {
    return stripMetadata(msg.text);
  }
  if (typeof msg.content === "string") {
    return stripMetadata(msg.content);
  }
  if (Array.isArray(msg.content)) {
    const parts = (msg.content as Array<Record<string, unknown>>).flatMap(
      (block) => {
        if (block?.type === "text" && typeof block.text === "string") {
          return [block.text as string];
        }
        return [] as string[];
      },
    );
    return stripMetadata(parts.join("\n"));
  }
  return "";
}

function makeLocalMessageId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function DesktopChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id: sessionParam } = useParams<{ id: string }>();

  const [activeSessionKey, setActiveSessionKey] = useState<string | null>(null);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [streamMessages, setStreamMessages] = useState<StreamMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const botsQuery = useQuery({
    queryKey: ["desktop-chat-bots"],
    queryFn: async (): Promise<DesktopBot[]> => {
      const { data } = await getApiV1Bots();
      return (data?.bots ?? []).map((bot) => ({
        id: bot.id,
        name: bot.name || bot.slug || bot.id,
      }));
    },
  });

  const sessionsQuery = useQuery({
    queryKey: ["desktop-chat-sessions"],
    queryFn: async (): Promise<DesktopSession[]> => {
      const { data } = await getApiV1Sessions({
        query: { channelType: "desktop", limit: 100 },
      });
      return (data?.sessions ?? []).map((session) => ({
        id: session.id,
        sessionKey: session.sessionKey,
        botId: session.botId,
        title: session.title || t("desktopChat.untitled"),
        updatedAt: session.updatedAt,
        lastMessageAt: session.lastMessageAt,
      }));
    },
    refetchInterval: 15_000,
  });

  const bots = botsQuery.data ?? [];
  const sessions = useMemo(
    () => sessionsQuery.data ?? [],
    [sessionsQuery.data],
  );

  // Sync URL param -> local state. When ?id=new or unset we treat as new chat.
  // Only wipe stream messages when the URL param itself changes so periodic
  // sessions refetches don't blow away in-flight optimistic messages.
  useEffect(() => {
    if (!sessionParam || sessionParam === "new") {
      setActiveSessionKey((previous) => (previous === null ? previous : null));
      setStreamMessages([]);
      return;
    }
    setActiveSessionKey((previous) =>
      previous === sessionParam ? previous : sessionParam,
    );
    setStreamMessages([]);
  }, [sessionParam]);

  // When sessions list contains the current session, adopt its botId so the
  // agent selector matches what's on disk.
  useEffect(() => {
    if (!activeSessionKey) return;
    const match = sessions.find(
      (session) => session.sessionKey === activeSessionKey,
    );
    if (match && match.botId !== activeBotId) {
      setActiveBotId(match.botId);
    }
  }, [activeSessionKey, activeBotId, sessions]);

  // Pick a default bot when we don't have one yet.
  useEffect(() => {
    if (activeBotId || bots.length === 0) return;
    setActiveBotId(bots[0]?.id ?? null);
  }, [bots, activeBotId]);

  const activeSession = sessions.find(
    (session) => session.sessionKey === activeSessionKey,
  );

  const historyQuery = useQuery({
    queryKey: ["desktop-chat-history", activeSession?.id ?? null],
    queryFn: async (): Promise<StreamMessage[]> => {
      if (!activeSession) return [];
      const { data } = await getApiV1SessionsByIdMessages({
        path: { id: activeSession.id },
        query: { limit: 200 },
      });
      const raw =
        ((data as { messages?: Array<Record<string, unknown>> } | undefined)
          ?.messages ?? []) as Array<Record<string, unknown>>;
      return raw
        .map((message) => ({
          id: String(message.id ?? makeLocalMessageId()),
          role: (message.role === "assistant" ? "assistant" : "user") as
            | "assistant"
            | "user",
          text: extractText(message),
        }))
        .filter((message) => message.text.trim().length > 0);
    },
    enabled: Boolean(activeSession?.id),
  });

  const historyMessages = useMemo(
    () => historyQuery.data ?? [],
    [historyQuery.data],
  );

  const combinedMessages = useMemo(
    () => [...historyMessages, ...streamMessages],
    [historyMessages, streamMessages],
  );

  const isStreaming = streamMessages.some((message) => message.pending);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [combinedMessages]);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      // First-install path: activeBotId may still be null while the bots
      // query is loading (or the user has never created a bot). The
      // controller will auto-provision a default bot in that case, so we
      // just send `botId: undefined` and let the server decide.
      const controller = new AbortController();
      abortRef.current = controller;

      const userMessage: StreamMessage = {
        id: makeLocalMessageId(),
        role: "user",
        text,
      };
      const assistantMessage: StreamMessage = {
        id: makeLocalMessageId(),
        role: "assistant",
        text: "",
        pending: true,
      };
      setStreamMessages((previous) => [
        ...previous,
        userMessage,
        assistantMessage,
      ]);

      let assignedSessionKey = activeSessionKey;
      let sawError = false;

      await streamDesktopChat(
        {
          botId: activeBotId ?? undefined,
          sessionKey: activeSessionKey ?? undefined,
          text,
        },
        {
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "session": {
                assignedSessionKey = event.sessionKey;
                if (!activeSessionKey) {
                  setActiveSessionKey(event.sessionKey);
                }
                // On first install we may not have picked a bot yet; the
                // server auto-provisions one and reports its id here.
                if (!activeBotId) {
                  setActiveBotId(event.botId);
                }
                break;
              }
              case "toolCall": {
                setStreamMessages((previous) =>
                  previous.map((message) =>
                    message.id === assistantMessage.id
                      ? {
                          ...message,
                          text:
                            message.text.length > 0
                              ? `${message.text}\n\n[tool] ${event.summary ?? event.name}`
                              : `[tool] ${event.summary ?? event.name}`,
                        }
                      : message,
                  ),
                );
                break;
              }
              case "delta": {
                setStreamMessages((previous) =>
                  previous.map((message) =>
                    message.id === assistantMessage.id
                      ? { ...message, text: message.text + event.text }
                      : message,
                  ),
                );
                break;
              }
              case "error": {
                sawError = true;
                setStreamMessages((previous) =>
                  previous.map((message) =>
                    message.id === assistantMessage.id
                      ? {
                          ...message,
                          text:
                            message.text.length > 0
                              ? `${message.text}\n\n[${event.message}]`
                              : `[${event.message}]`,
                          error: true,
                          pending: false,
                        }
                      : message,
                  ),
                );
                break;
              }
              case "done": {
                setStreamMessages((previous) =>
                  previous.map((message) =>
                    message.id === assistantMessage.id
                      ? { ...message, pending: false }
                      : message,
                  ),
                );
                break;
              }
              default:
                break;
            }
          },
        },
      );

      if (abortRef.current === controller) {
        abortRef.current = null;
      }

      // Refresh the sessions list so the new session shows up in the sidebar,
      // then drop our optimistic stream messages once the history query
      // catches up on next fetch.
      await queryClient.invalidateQueries({
        queryKey: ["desktop-chat-sessions"],
      });
      if (assignedSessionKey && !sawError) {
        await queryClient.invalidateQueries({
          queryKey: ["desktop-chat-history"],
        });
      }
      return { sawError, sessionKey: assignedSessionKey };
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
      setStreamMessages((previous) =>
        previous.map((message) =>
          message.pending
            ? {
                ...message,
                pending: false,
                error: true,
                text:
                  message.text.length > 0
                    ? message.text
                    : `[${error instanceof Error ? error.message : String(error)}]`,
              }
            : message,
        ),
      );
    },
    onSuccess: async (result) => {
      // Once the sessions/history queries have refreshed with the persisted
      // transcript, clear the optimistic buffer (unless we're in an error
      // state we still want to show).
      if (!result?.sawError) {
        setTimeout(() => {
          setStreamMessages((previous) =>
            previous.filter((message) => message.pending || message.error),
          );
        }, 800);
      }
      if (result?.sessionKey && !sessionParam) {
        navigate(`/workspace/chat/${result.sessionKey}`, { replace: true });
      }
    },
  });

  const handleSubmit = useCallback(() => {
    const value = draft.trim();
    if (!value || sendMutation.isPending) return;
    setDraft("");
    sendMutation.mutate(value);
    // Refetch the bots list — on first install the server just auto-provisioned
    // one, so this pulls it into the sidebar's model selector state.
    void queryClient.invalidateQueries({ queryKey: ["desktop-chat-bots"] });
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
    });
  }, [draft, sendMutation, queryClient]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleNewChat = useCallback(() => {
    setActiveSessionKey(null);
    setStreamMessages([]);
    setDraft("");
    navigate("/workspace/chat");
  }, [navigate]);

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSubmit();
    }
  };

  // The server auto-provisions a default bot on the first message when none
  // exists, so an empty bots list is NOT a blocking state.
  const noBots = false;

  return (
    <div className="flex h-full flex-col">
      {/* Main chat pane — conversation history lives in the left sidebar */}
      <div className="flex-1 flex flex-col min-h-0">
        <header className="shrink-0 border-b border-border px-6 py-4 md:pt-8">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-[15px] font-bold text-text-heading truncate">
                {activeSession?.title ?? t("desktopChat.newChat")}
              </h1>
              <div className="mt-0.5 text-[11px] text-text-muted">
                {t("desktopChat.subtitle")}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {bots.length > 0 && (
                <select
                  id="desktop-chat-bot-select"
                  aria-label={t("desktopChat.agent")}
                  value={activeBotId ?? ""}
                  onChange={(event) => setActiveBotId(event.target.value)}
                  disabled={Boolean(activeSession)}
                  className="rounded-md border border-border bg-surface-1 px-2 py-1.5 text-[12px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                >
                  {bots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={handleNewChat}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13px] font-medium text-text-primary hover:bg-surface-2"
              >
                <MessageSquarePlus size={16} />
                {t("desktopChat.newChat")}
              </button>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0 px-4 py-6 sm:px-6">
          {noBots ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <div className="text-[13px] text-text-muted">
                  {t("desktopChat.error.noBot")}
                </div>
              </div>
            </div>
          ) : combinedMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center">
              <div>
                <div className="mb-2 text-lg font-medium text-text-primary">
                  {t("desktopChat.emptyTitle")}
                </div>
                <div className="text-[13px] text-text-muted max-w-md">
                  {t("desktopChat.emptyDesc")}
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex w-full max-w-[920px] flex-col gap-5">
              {combinedMessages.map((message) => {
                const isBot = message.role === "assistant";
                return (
                  <div
                    key={message.id}
                    data-desktop-chat-message={message.id}
                    data-desktop-chat-role={message.role}
                    className={cn(
                      "flex gap-3",
                      isBot ? "items-start" : "flex-row-reverse items-end",
                    )}
                  >
                    {isBot ? (
                      <img
                        src={BOT_AVATAR}
                        alt=""
                        className="shrink-0 w-9 h-9 -ml-1 mt-0 object-contain"
                      />
                    ) : (
                      <div className="w-7 h-7 mt-0.5 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center shrink-0">
                        <span className="text-[11px] font-semibold text-white leading-none">
                          {t("desktopChat.youInitial")}
                        </span>
                      </div>
                    )}
                    <div
                      className={cn(
                        "flex max-w-[44rem] flex-col gap-1",
                        isBot ? "items-start" : "items-end text-right",
                      )}
                    >
                      <div
                        className={cn(
                          "inline-block max-w-full rounded-[20px] px-4 py-3 text-[13px] break-words shadow-[0_10px_24px_rgba(15,23,42,0.04)]",
                          isBot
                            ? "border border-border bg-surface-1 text-text-primary rounded-tl-sm"
                            : "bg-surface-3 text-text-primary rounded-tr-sm",
                          message.error && "border-destructive text-destructive",
                        )}
                      >
                        {message.text.length > 0 ? (
                          isBot ? (
                            <ChatMarkdown content={message.text} />
                          ) : (
                            <span className="whitespace-pre-wrap">
                              {message.text}
                            </span>
                          )
                        ) : (
                          <Loader2
                            className="animate-spin text-text-muted"
                            size={14}
                          />
                        )}
                      </div>
                      {isBot && message.pending && message.text.length > 0 && (
                        <div className="pl-1 text-[10px] text-text-muted">
                          {t("desktopChat.streaming")}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form
          className="shrink-0 border-t border-border bg-surface-1 px-4 py-3 sm:px-6"
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <div className="mx-auto flex w-full max-w-[920px] items-end gap-2">
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleKeyDown}
              onInput={(event) => {
                const el = event.currentTarget;
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
              }}
              rows={1}
              placeholder={t("desktopChat.inputPlaceholder")}
              disabled={noBots}
              className="flex-1 resize-none rounded-[14px] border border-border bg-surface-1 px-4 py-3 text-[13px] text-text-primary shadow-[0_1px_2px_rgba(15,23,42,0.04)] focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleAbort}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-surface-1 text-text-primary hover:bg-surface-2"
                aria-label={t("desktopChat.abort")}
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="submit"
                disabled={draft.trim().length === 0 || noBots}
                className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-accent text-white hover:opacity-90 disabled:opacity-40"
                aria-label={t("desktopChat.send")}
              >
                <Send size={16} />
              </button>
            )}
          </div>
          <div className="mx-auto mt-1.5 max-w-[920px] text-[10px] text-text-muted">
            {t("desktopChat.hint")}
          </div>
        </form>
      </div>
    </div>
  );
}
