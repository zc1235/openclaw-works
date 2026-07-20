import {
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
} from "@/lib/mcp-api";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type Transport = "http" | "stdio";

const MCP_QUERY_KEY = ["mcp-servers"];

export function McpServersPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("http");
  const [url, setUrl] = useState("");
  const [bearerToken, setBearerToken] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  const { data: servers = [], isLoading } = useQuery({
    queryKey: MCP_QUERY_KEY,
    queryFn: listMcpServers,
  });

  const resetForm = () => {
    setName("");
    setTransport("http");
    setUrl("");
    setBearerToken("");
    setCommand("");
    setArgsText("");
    setShowForm(false);
  };

  const createMutation = useMutation({
    mutationFn: createMcpServer,
    onSuccess: () => {
      toast.success(t("mcp.addSuccess"));
      resetForm();
      void queryClient.invalidateQueries({ queryKey: MCP_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteMcpServer,
    onSuccess: () => {
      toast.success(t("mcp.deleteSuccess"));
      void queryClient.invalidateQueries({ queryKey: MCP_QUERY_KEY });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      toast.error(t("mcp.nameRequired"));
      return;
    }
    if (transport === "http") {
      if (url.trim().length === 0) {
        toast.error(t("mcp.urlRequired"));
        return;
      }
      createMutation.mutate({
        name: trimmedName,
        transport: "http",
        url: url.trim(),
        ...(bearerToken.trim().length > 0
          ? { bearerToken: bearerToken.trim() }
          : {}),
      });
      return;
    }
    if (command.trim().length === 0) {
      toast.error(t("mcp.commandRequired"));
      return;
    }
    const args = argsText
      .split(/\s+/)
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    createMutation.mutate({
      name: trimmedName,
      transport: "stdio",
      command: command.trim(),
      args,
    });
  };

  const inputClass =
    "w-full px-3 py-2 rounded-lg border border-border bg-surface-1 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/30";

  return (
    <div className="mb-6 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10">
            <Server size={16} className="text-accent" />
          </div>
          <div>
            <div className="text-[14px] font-semibold text-text-primary">
              {t("mcp.title")}
            </div>
            <div className="text-[12px] text-text-muted">
              {t("mcp.subtitle")}
            </div>
          </div>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover"
          >
            <Plus size={14} />
            {t("mcp.add")}
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 size={18} className="animate-spin text-text-muted" />
        </div>
      ) : servers.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {servers.map((server) => (
            <li
              key={server.id}
              className="flex items-center justify-between rounded-lg border border-border bg-surface-0 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-text-primary truncate">
                    {server.name}
                  </span>
                  <span className="shrink-0 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                    {server.transport}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-text-muted">
                  {server.transport === "http"
                    ? server.url
                    : [server.command, ...server.args].join(" ")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => deleteMutation.mutate(server.id)}
                disabled={deleteMutation.isPending}
                className="ml-3 shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                aria-label={t("mcp.delete")}
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !showForm && (
          <div className="mt-4 rounded-lg border border-dashed border-border py-6 text-center text-[12px] text-text-muted">
            {t("mcp.empty")}
          </div>
        )
      )}

      {showForm && (
        <div className="mt-4 space-y-3 rounded-lg border border-border bg-surface-0 p-3">
          <div>
            <label
              htmlFor="mcp-name"
              className="mb-1 block text-[12px] font-medium text-text-secondary"
            >
              {t("mcp.name")}
            </label>
            <input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("mcp.namePlaceholder")}
              className={inputClass}
            />
          </div>

          <div>
            <span className="mb-1 block text-[12px] font-medium text-text-secondary">
              {t("mcp.transport")}
            </span>
            <div className="flex gap-2">
              {(["http", "stdio"] as Transport[]).map((value) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => setTransport(value)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors",
                    transport === value
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-text-muted hover:text-text-primary",
                  )}
                >
                  {value === "http" ? t("mcp.transportHttp") : t("mcp.transportStdio")}
                </button>
              ))}
            </div>
          </div>

          {transport === "http" ? (
            <>
              <div>
                <label
                  htmlFor="mcp-url"
                  className="mb-1 block text-[12px] font-medium text-text-secondary"
                >
                  {t("mcp.url")}
                </label>
                <input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/mcp"
                  className={inputClass}
                />
              </div>
              <div>
                <label
                  htmlFor="mcp-token"
                  className="mb-1 block text-[12px] font-medium text-text-secondary"
                >
                  {t("mcp.token")}
                </label>
                <input
                  id="mcp-token"
                  value={bearerToken}
                  onChange={(e) => setBearerToken(e.target.value)}
                  placeholder={t("mcp.tokenPlaceholder")}
                  className={inputClass}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label
                  htmlFor="mcp-command"
                  className="mb-1 block text-[12px] font-medium text-text-secondary"
                >
                  {t("mcp.command")}
                </label>
                <input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx"
                  className={inputClass}
                />
              </div>
              <div>
                <label
                  htmlFor="mcp-args"
                  className="mb-1 block text-[12px] font-medium text-text-secondary"
                >
                  {t("mcp.args")}
                </label>
                <input
                  id="mcp-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-filesystem /path"
                  className={inputClass}
                />
              </div>
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={resetForm}
              className="rounded-lg px-4 py-2 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-3"
            >
              {t("mcp.cancel")}
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={createMutation.isPending}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {createMutation.isPending && (
                <Loader2 size={14} className="animate-spin" />
              )}
              {t("mcp.save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
