import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  createMcpServerSchema,
  mcpServerListResponseSchema,
  mcpServerResponseSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import type { ControllerBindings } from "../types.js";

const mcpServerIdParamSchema = z.object({ id: z.string() });
const errorSchema = z.object({ message: z.string() });
const okSchema = z.object({ ok: z.boolean() });

export function registerMcpRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/mcp-servers",
      tags: ["MCP"],
      responses: {
        200: {
          content: {
            "application/json": { schema: mcpServerListResponseSchema },
          },
          description: "List configured MCP servers",
        },
      },
    }),
    async (c) => {
      const servers = await container.configStore.listMcpServers();
      return c.json({ servers }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/mcp-servers",
      tags: ["MCP"],
      request: {
        body: {
          content: {
            "application/json": { schema: createMcpServerSchema },
          },
          required: true,
        },
      },
      responses: {
        201: {
          content: {
            "application/json": { schema: mcpServerResponseSchema },
          },
          description: "Created MCP server",
        },
      },
    }),
    async (c) => {
      const server = await container.configStore.createMcpServer(
        c.req.valid("json"),
      );
      // Push the updated mcporter config to disk so the runtime picks it up.
      await container.openclawSyncService.syncAll();
      return c.json(server, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/mcp-servers/{id}",
      tags: ["MCP"],
      request: { params: mcpServerIdParamSchema },
      responses: {
        200: {
          content: { "application/json": { schema: okSchema } },
          description: "Deleted MCP server",
        },
        404: {
          content: { "application/json": { schema: errorSchema } },
          description: "Not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const removed = await container.configStore.deleteMcpServer(id);
      if (!removed) {
        return c.json({ message: "MCP server not found" }, 404);
      }
      await container.openclawSyncService.syncAll();
      return c.json({ ok: true }, 200);
    },
  );
}
