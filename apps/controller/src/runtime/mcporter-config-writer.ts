import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { McpServerResponse } from "@nexu/shared";
import { logger } from "../lib/logger.js";

/**
 * Writes the user's MCP servers into mcporter's home config so the bundled
 * OpenClaw runtime (which reaches MCP servers via mcporter) can call them.
 *
 * mcporter loads `~/.mcporter/mcporter.json` first (merged with repo-scoped
 * config). The OpenClaw process inherits the controller's environment,
 * including HOME, so this home-dir location is what the runtime resolves.
 *
 * We own the `mcpServers` map (the nexu UI is the source of truth) but
 * preserve any other top-level keys a user may have added manually.
 */
export class McporterConfigWriter {
  private readonly configPath: string;

  constructor() {
    this.configPath = path.join(homedir(), ".mcporter", "mcporter.json");
  }

  private buildServerEntry(
    server: McpServerResponse,
  ): Record<string, unknown> {
    if (server.transport === "http") {
      const entry: Record<string, unknown> = {
        baseUrl: server.url ?? "",
      };
      if (server.bearerToken && server.bearerToken.length > 0) {
        entry.headers = { Authorization: `Bearer ${server.bearerToken}` };
      }
      return entry;
    }
    // stdio
    const entry: Record<string, unknown> = {
      command: server.command ?? "",
    };
    if (server.args.length > 0) {
      entry.args = server.args;
    }
    return entry;
  }

  async write(servers: readonly McpServerResponse[]): Promise<void> {
    const mcpServers: Record<string, unknown> = {};
    for (const server of servers) {
      if (server.name.length === 0) {
        continue;
      }
      mcpServers[server.name] = this.buildServerEntry(server);
    }

    // Preserve unrelated top-level keys from an existing file if present.
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // No existing file (or unreadable) — start fresh.
    }

    const next = {
      ...existing,
      mcpServers,
    };

    try {
      await mkdir(path.dirname(this.configPath), { recursive: true });
      await writeFile(this.configPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      logger.info(
        { configPath: this.configPath, serverCount: servers.length },
        "mcporter_config_written",
      );
    } catch (error) {
      logger.error(
        {
          configPath: this.configPath,
          error: error instanceof Error ? error.message : String(error),
        },
        "mcporter_config_write_failed",
      );
    }
  }
}
