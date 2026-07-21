import { z } from "zod";

/**
 * Scheduled tasks let a user ask their agent to run an instruction on a
 * recurring basis. The UI never asks for a raw cron expression — the user
 * picks a friendly frequency and (optionally) a time, and the backend derives
 * the cron string. The controller's SchedulerService performs the actual
 * timing via date math on the structured `schedule` fields.
 */
export const scheduleFrequencySchema = z.enum([
  "minutely",
  "hourly",
  "daily",
  "weekly",
  "monthly",
]);
export type ScheduleFrequency = z.infer<typeof scheduleFrequencySchema>;

export const scheduledTaskScheduleSchema = z.object({
  frequency: scheduleFrequencySchema,
  /** Minute of the hour (0-59). Used by hourly/daily/weekly/monthly. */
  minute: z.number().int().min(0).max(59).default(0),
  /** Hour of the day (0-23). Used by daily/weekly/monthly. */
  hour: z.number().int().min(0).max(23).default(9),
  /** Day of week (0=Sunday .. 6=Saturday). Used by weekly. */
  dayOfWeek: z.number().int().min(0).max(6).default(1),
  /** Day of month (1-31, clamped to month length). Used by monthly. */
  dayOfMonth: z.number().int().min(1).max(31).default(1),
});
export type ScheduledTaskSchedule = z.infer<typeof scheduledTaskScheduleSchema>;

export const scheduledTaskRunStatusSchema = z.enum([
  "success",
  "error",
  "running",
]);
export type ScheduledTaskRunStatus = z.infer<
  typeof scheduledTaskRunStatusSchema
>;

export const scheduledTaskResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The natural-language instruction the agent runs on each fire. */
  instruction: z.string(),
  /** Bot/agent that runs the task; null uses the default bot. */
  botId: z.string().nullable(),
  schedule: scheduledTaskScheduleSchema,
  /** Derived 5-field cron expression (for display / future openclaw use). */
  cron: z.string(),
  /** IM channel id to notify on completion (null disables notification). */
  notifyChannelId: z.string().nullable(),
  /** Recipient id on the notify channel (chat id / user id). */
  notifyTarget: z.string().nullable(),
  enabled: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastStatus: scheduledTaskRunStatusSchema.nullable(),
  lastResult: z.string().nullable(),
  lastError: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  runCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ScheduledTaskResponse = z.infer<typeof scheduledTaskResponseSchema>;

export const createScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200),
  instruction: z.string().min(1).max(4000),
  botId: z.string().nullable().optional(),
  schedule: scheduledTaskScheduleSchema,
  notifyChannelId: z.string().nullable().optional(),
  notifyTarget: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type CreateScheduledTaskInput = z.infer<
  typeof createScheduledTaskSchema
>;

export const updateScheduledTaskSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  instruction: z.string().min(1).max(4000).optional(),
  botId: z.string().nullable().optional(),
  schedule: scheduledTaskScheduleSchema.optional(),
  notifyChannelId: z.string().nullable().optional(),
  notifyTarget: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateScheduledTaskInput = z.infer<
  typeof updateScheduledTaskSchema
>;

export const scheduledTaskListResponseSchema = z.object({
  tasks: z.array(scheduledTaskResponseSchema),
});
export type ScheduledTaskListResponse = z.infer<
  typeof scheduledTaskListResponseSchema
>;

/**
 * Build a standard 5-field cron expression
 * (`minute hour day-of-month month day-of-week`) from a friendly schedule.
 */
export function buildCronFromSchedule(schedule: ScheduledTaskSchedule): string {
  const minute = schedule.minute ?? 0;
  const hour = schedule.hour ?? 0;
  const dayOfWeek = schedule.dayOfWeek ?? 0;
  const dayOfMonth = schedule.dayOfMonth ?? 1;
  switch (schedule.frequency) {
    case "minutely":
      return "* * * * *";
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekly":
      return `${minute} ${hour} * * ${dayOfWeek}`;
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    default:
      return "* * * * *";
  }
}
