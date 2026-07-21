import crypto from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  type ScheduledTaskResponse,
  buildCronFromSchedule,
  createScheduledTaskSchema,
  scheduledTaskListResponseSchema,
  scheduledTaskResponseSchema,
  updateScheduledTaskSchema,
} from "@nexu/shared";
import type { ControllerContainer } from "../app/container.js";
import { SchedulerService } from "../services/scheduler-service.js";
import type { ControllerBindings } from "../types.js";

function nowIso(): string {
  return new Date().toISOString();
}

export function registerScheduledTaskRoutes(
  app: OpenAPIHono<ControllerBindings>,
  container: ControllerContainer,
): void {
  const idParamSchema = z.object({ id: z.string() });

  // List all scheduled tasks.
  app.openapi(
    createRoute({
      method: "get",
      path: "/api/v1/scheduled-tasks",
      tags: ["Scheduled Tasks"],
      responses: {
        200: {
          content: {
            "application/json": { schema: scheduledTaskListResponseSchema },
          },
          description: "List of scheduled tasks",
        },
      },
    }),
    async (c) => {
      const tasks = await container.configStore.listScheduledTasks();
      return c.json({ tasks }, 200);
    },
  );

  // Create a scheduled task. The cron string and nextRunAt are derived here.
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/scheduled-tasks",
      tags: ["Scheduled Tasks"],
      request: {
        body: {
          content: {
            "application/json": { schema: createScheduledTaskSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: scheduledTaskResponseSchema },
          },
          description: "Created scheduled task",
        },
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const createdAt = nowIso();
      const task: ScheduledTaskResponse = {
        id: crypto.randomUUID(),
        name: body.name,
        instruction: body.instruction,
        botId: body.botId ?? null,
        schedule: body.schedule,
        cron: buildCronFromSchedule(body.schedule),
        notifyChannelId: body.notifyChannelId ?? null,
        notifyTarget: body.notifyTarget ?? null,
        enabled: body.enabled ?? true,
        lastRunAt: null,
        lastStatus: null,
        lastResult: null,
        lastError: null,
        nextRunAt: SchedulerService.computeNextRun(
          body.schedule,
          new Date(),
        ).toISOString(),
        runCount: 0,
        createdAt,
        updatedAt: createdAt,
      };
      const created = await container.configStore.createScheduledTask(task);
      return c.json(created, 200);
    },
  );

  // Update a scheduled task (fields + schedule). Recomputes cron/nextRunAt
  // when the schedule changes.
  app.openapi(
    createRoute({
      method: "patch",
      path: "/api/v1/scheduled-tasks/{id}",
      tags: ["Scheduled Tasks"],
      request: {
        params: idParamSchema,
        body: {
          content: {
            "application/json": { schema: updateScheduledTaskSchema },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: {
            "application/json": { schema: scheduledTaskResponseSchema },
          },
          description: "Updated scheduled task",
        },
        404: {
          content: {
            "application/json": { schema: z.object({ error: z.string() }) },
          },
          description: "Task not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const patch: Partial<ScheduledTaskResponse> = { updatedAt: nowIso() };
      if (body.name !== undefined) patch.name = body.name;
      if (body.instruction !== undefined) patch.instruction = body.instruction;
      if (body.botId !== undefined) patch.botId = body.botId ?? null;
      if (body.notifyChannelId !== undefined)
        patch.notifyChannelId = body.notifyChannelId ?? null;
      if (body.notifyTarget !== undefined)
        patch.notifyTarget = body.notifyTarget ?? null;
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.schedule !== undefined) {
        patch.schedule = body.schedule;
        patch.cron = buildCronFromSchedule(body.schedule);
        patch.nextRunAt = SchedulerService.computeNextRun(
          body.schedule,
          new Date(),
        ).toISOString();
      }
      const updated = await container.configStore.updateScheduledTask(
        id,
        patch,
      );
      if (!updated) {
        return c.json({ error: "Scheduled task not found" }, 404);
      }
      return c.json(updated, 200);
    },
  );

  // Delete a scheduled task.
  app.openapi(
    createRoute({
      method: "delete",
      path: "/api/v1/scheduled-tasks/{id}",
      tags: ["Scheduled Tasks"],
      request: { params: idParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
          description: "Deletion result",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const ok = await container.configStore.deleteScheduledTask(id);
      return c.json({ ok }, 200);
    },
  );

  // Trigger an immediate run.
  app.openapi(
    createRoute({
      method: "post",
      path: "/api/v1/scheduled-tasks/{id}/run",
      tags: ["Scheduled Tasks"],
      request: { params: idParamSchema },
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ ok: z.boolean() }) },
          },
          description: "Run triggered",
        },
        404: {
          content: {
            "application/json": { schema: z.object({ error: z.string() }) },
          },
          description: "Task not found",
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const task = await container.configStore.getScheduledTask(id);
      if (!task) {
        return c.json({ error: "Scheduled task not found" }, 404);
      }
      // Fire and forget — the run persists its own result/status.
      void container.schedulerService.runTask(id);
      return c.json({ ok: true }, 200);
    },
  );
}
