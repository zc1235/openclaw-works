import { z } from "zod";

/**
 * MCP (Model Context Protocol) server management.
 *
 * OpenClaw 2026.3.7 does not read MCP servers from its own config; it reaches
 * MCP servers through the bundled `mcporter` tool, which loads servers from
 * `~/.mcporter/mcporter.json`. The controller persists the user's MCP servers
 * in nexu config and writes that mcporter config on every sync, so the agent
 * can call the servers' tools.
 *
 * Two transports are supported to keep the UI simple:
 *  - "http":  a remote streamable-HTTP MCP endpoint (url + optional bearer token)
 *  - "stdio": a local command the runtime spawns (command + args + env)
 */

export const mcpTransportSchema = z.enum(["http", "stdio"]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpServerResponseSchema = z.object({
  id: z.string(),
  /** Unique, human-typed key used as the mcporter server name. */
  name: z.string(),
  transport: mcpTransportSchema,
  /** For http transport. */
  url: z.string().nullable(),
  /** Optional bearer token for http transport (stored as Authorization header). */
  bearerToken: z.string().nullable(),
  /** For stdio transport. */
  command: z.string().nullable(),
  args: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type McpServerResponse = z.infer<typeof mcpServerResponseSchema>;

export const mcpServerListResponseSchema = z.object({
  servers: z.array(mcpServerResponseSchema),
});
export type McpServerListResponse = z.infer<typeof mcpServerListResponseSchema>;

// Server name: lowercase-friendly identifier used as the mcporter key.
const mcpServerNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
    "Name must start with a letter or number and contain only letters, numbers, - and _",
  );

export const createMcpServerSchema = z
  .object({
    name: mcpServerNameSchema,
    transport: mcpTransportSchema,
    url: z.string().url().optional(),
    bearerToken: z.string().optional(),
    command: z.string().min(1).optional(),
    // Free-form args entered as a single string are split on the client;
    // the API accepts an explicit array.
    args: z.array(z.string()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.transport === "http" && !value.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url is required for http transport",
      });
    }
    if (value.transport === "stdio" && !value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is required for stdio transport",
      });
    }
  });
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
