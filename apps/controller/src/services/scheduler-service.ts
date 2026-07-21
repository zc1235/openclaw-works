import type { ScheduledTaskResponse, ScheduledTaskSchedule } from "@nexu/shared";
import type { RunAgentResult } from "../lib/agent-runner.js";
import { logger } from "../lib/logger.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";

const TICK_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 8_000;
const MAX_RESULT_CHARS = 4_000;

interface SchedulerDeps {
  configStore: NexuConfigStore;
  gatewayService: OpenClawGatewayService;
  /** Runs a task's instruction through its agent and returns the result. */
  runInstruction: (task: ScheduledTaskResponse) => Promise<RunAgentResult>;
}

/**
 * In-process scheduler for recurring tasks. Ticks on an interval, runs any due
 * task through its agent, records the outcome, and (optionally) notifies an IM
 * channel with the result. Timing is computed via date math on the task's
 * structured schedule — no cron parser dependency.
 */
export class SchedulerService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private readonly running = new Set<string>();

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    // Kick a first tick shortly after boot so overdue tasks fire promptly.
    this.initialTimer = setTimeout(() => {
      void this.tick();
    }, INITIAL_DELAY_MS);
    this.initialTimer.unref?.();
    logger.info({}, "scheduler_started");
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  /**
   * Compute the next fire time strictly after `from` for a schedule.
   * Exposed so routes can seed `nextRunAt` on create/update.
   */
  static computeNextRun(schedule: ScheduledTaskSchedule, from: Date): Date {
    const minute = schedule.minute ?? 0;
    const hour = schedule.hour ?? 0;
    const next = new Date(from.getTime());
    next.setSeconds(0, 0);

    switch (schedule.frequency) {
      case "minutely": {
        next.setMinutes(next.getMinutes() + 1);
        return next;
      }
      case "hourly": {
        next.setMinutes(minute);
        if (next <= from) {
          next.setHours(next.getHours() + 1);
        }
        return next;
      }
      case "daily": {
        next.setHours(hour, minute, 0, 0);
        if (next <= from) {
          next.setDate(next.getDate() + 1);
        }
        return next;
      }
      case "weekly": {
        const dayOfWeek = schedule.dayOfWeek ?? 0;
        next.setHours(hour, minute, 0, 0);
        let delta = (dayOfWeek - next.getDay() + 7) % 7;
        if (delta === 0 && next <= from) {
          delta = 7;
        }
        next.setDate(next.getDate() + delta);
        return next;
      }
      case "monthly": {
        const dayOfMonth = schedule.dayOfMonth ?? 1;
        const clampDay = (d: Date) => {
          const daysInMonth = new Date(
            d.getFullYear(),
            d.getMonth() + 1,
            0,
          ).getDate();
          d.setDate(Math.min(dayOfMonth, daysInMonth));
        };
        next.setHours(hour, minute, 0, 0);
        clampDay(next);
        if (next <= from) {
          // Advance to the first of next month before clamping to avoid
          // day-overflow rolling into the wrong month.
          next.setDate(1);
          next.setMonth(next.getMonth() + 1);
          next.setHours(hour, minute, 0, 0);
          clampDay(next);
        }
        return next;
      }
      default:
        next.setMinutes(next.getMinutes() + 1);
        return next;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      const tasks = await this.deps.configStore.listScheduledTasks();
      const now = new Date();
      for (const task of tasks) {
        if (!task.enabled) {
          continue;
        }
        if (this.running.has(task.id)) {
          continue;
        }
        const due = task.nextRunAt
          ? new Date(task.nextRunAt).getTime() <= now.getTime()
          : true;
        if (due) {
          void this.runTask(task.id);
        }
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "scheduler_tick_failed",
      );
    } finally {
      this.ticking = false;
    }
  }

  /** Run a task immediately (used by the tick loop and the "run now" route). */
  async runTask(taskId: string): Promise<void> {
    if (this.running.has(taskId)) {
      return;
    }
    this.running.add(taskId);
    try {
      const task = await this.deps.configStore.getScheduledTask(taskId);
      if (!task) {
        return;
      }

      await this.deps.configStore.updateScheduledTask(taskId, {
        lastStatus: "running",
        lastRunAt: new Date().toISOString(),
      });

      let result: RunAgentResult;
      try {
        result = await this.deps.runInstruction(task);
      } catch (error) {
        result = {
          ok: false,
          text: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      const nextRunAt = SchedulerService.computeNextRun(
        task.schedule,
        new Date(),
      ).toISOString();

      if (!result.ok) {
        await this.deps.configStore.updateScheduledTask(taskId, {
          lastStatus: "error",
          lastError: result.error ?? "Unknown error",
          nextRunAt,
          runCount: (task.runCount ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        });
        logger.warn(
          { taskId, error: result.error },
          "scheduled_task_run_failed",
        );
        return;
      }

      const resultText = result.text.slice(0, MAX_RESULT_CHARS);
      await this.deps.configStore.updateScheduledTask(taskId, {
        lastStatus: "success",
        lastResult: resultText,
        lastError: null,
        nextRunAt,
        runCount: (task.runCount ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });

      if (task.notifyChannelId && task.notifyTarget) {
        await this.notifyChannel(task, resultText);
      }
    } catch (error) {
      logger.error(
        {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        },
        "scheduled_task_run_exception",
      );
      await this.deps.configStore
        .updateScheduledTask(taskId, {
          lastStatus: "error",
          lastError: error instanceof Error ? error.message : String(error),
        })
        .catch(() => {});
    } finally {
      this.running.delete(taskId);
    }
  }

  private async notifyChannel(
    task: ScheduledTaskResponse,
    resultText: string,
  ): Promise<void> {
    if (!task.notifyChannelId || !task.notifyTarget) {
      return;
    }
    try {
      const config = await this.deps.configStore.getConfig();
      const channel = config.channels.find(
        (entry) => entry.id === task.notifyChannelId,
      );
      if (!channel) {
        logger.warn(
          { taskId: task.id, channelId: task.notifyChannelId },
          "scheduled_task_notify_channel_missing",
        );
        return;
      }
      const message = `【${task.name}】\n${resultText || "(no output)"}`;
      await this.deps.gatewayService.sendChannelMessage({
        channel: channel.channelType,
        to: task.notifyTarget,
        message,
        accountId: channel.accountId,
      });
    } catch (error) {
      logger.warn(
        {
          taskId: task.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "scheduled_task_notify_failed",
      );
    }
  }
}
