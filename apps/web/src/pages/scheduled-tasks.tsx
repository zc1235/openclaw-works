import { Switch } from "@/components/ui/switch";
import type {
  ScheduleFrequency,
  ScheduledTaskResponse,
} from "@nexu/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Loader2, Play, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1Bots,
  getApiV1Channels,
} from "../../lib/api/sdk.gen";
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  runScheduledTask,
  updateScheduledTask,
} from "../lib/scheduled-tasks-api";

const FREQUENCIES: ScheduleFrequency[] = [
  "minutely",
  "hourly",
  "daily",
  "weekly",
  "monthly",
];

const TASKS_QUERY_KEY = ["scheduled-tasks"];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

interface CreateFormState {
  name: string;
  instruction: string;
  frequency: ScheduleFrequency;
  minute: number;
  hour: number;
  dayOfWeek: number;
  dayOfMonth: number;
  botId: string;
  notifyChannelId: string;
  notifyTarget: string;
}

const INITIAL_FORM: CreateFormState = {
  name: "",
  instruction: "",
  frequency: "daily",
  minute: 0,
  hour: 9,
  dayOfWeek: 1,
  dayOfMonth: 1,
  botId: "",
  notifyChannelId: "",
  notifyTarget: "",
};

export function ScheduledTasksPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<CreateFormState>(INITIAL_FORM);

  const describeSchedule = (task: ScheduledTaskResponse): string => {
    const s = task.schedule;
    const time = `${pad2(s.hour ?? 0)}:${pad2(s.minute ?? 0)}`;
    switch (s.frequency) {
      case "minutely":
        return t("scheduledTasks.desc.minutely");
      case "hourly":
        return t("scheduledTasks.desc.hourly", { minute: pad2(s.minute ?? 0) });
      case "daily":
        return t("scheduledTasks.desc.daily", { time });
      case "weekly":
        return t("scheduledTasks.desc.weekly", {
          day: t(`scheduledTasks.weekday.${s.dayOfWeek ?? 0}`),
          time,
        });
      case "monthly":
        return t("scheduledTasks.desc.monthly", {
          day: s.dayOfMonth ?? 1,
          time,
        });
      default:
        return task.cron;
    }
  };

  const tasksQuery = useQuery({
    queryKey: TASKS_QUERY_KEY,
    queryFn: listScheduledTasks,
    refetchInterval: 15_000,
  });

  const botsQuery = useQuery({
    queryKey: ["scheduled-tasks:bots"],
    queryFn: async () => {
      const { data } = await getApiV1Bots();
      return data?.bots ?? [];
    },
  });

  const channelsQuery = useQuery({
    queryKey: ["scheduled-tasks:channels"],
    queryFn: async () => {
      const { data } = await getApiV1Channels();
      return data?.channels ?? [];
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: TASKS_QUERY_KEY });

  const createMutation = useMutation({
    mutationFn: createScheduledTask,
    onSuccess: () => {
      invalidate();
      setShowCreate(false);
      setForm(INITIAL_FORM);
      toast.success(t("scheduledTasks.created"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      updateScheduledTask(id, { enabled }),
    onSuccess: invalidate,
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteScheduledTask,
    onSuccess: () => {
      invalidate();
      toast.success(t("scheduledTasks.deleted"));
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  const runMutation = useMutation({
    mutationFn: runScheduledTask,
    onSuccess: () => {
      toast.success(t("scheduledTasks.runTriggered"));
      setTimeout(invalidate, 2_000);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  function handleCreate() {
    if (form.name.trim().length === 0 || form.instruction.trim().length === 0) {
      toast.error(t("scheduledTasks.validation"));
      return;
    }
    createMutation.mutate({
      name: form.name.trim(),
      instruction: form.instruction.trim(),
      botId: form.botId || null,
      schedule: {
        frequency: form.frequency,
        minute: form.minute,
        hour: form.hour,
        dayOfWeek: form.dayOfWeek,
        dayOfMonth: form.dayOfMonth,
      },
      notifyChannelId: form.notifyChannelId || null,
      notifyTarget: form.notifyTarget.trim() || null,
      enabled: true,
    });
  }

  const tasks = tasksQuery.data ?? [];
  const channels = channelsQuery.data ?? [];
  const bots = botsQuery.data ?? [];

  const showMinute = form.frequency !== "minutely";
  const showHour =
    form.frequency === "daily" ||
    form.frequency === "weekly" ||
    form.frequency === "monthly";
  const showDayOfWeek = form.frequency === "weekly";
  const showDayOfMonth = form.frequency === "monthly";

  const inputClass =
    "rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13px] text-text-primary outline-none focus:border-accent/50";

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-[18px] font-semibold text-text-primary">
            {t("scheduledTasks.title")}
          </h1>
          <p className="mt-1 text-[12px] text-text-tertiary">
            {t("scheduledTasks.subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[13px] font-medium text-white hover:opacity-90"
        >
          <Plus size={15} />
          {t("scheduledTasks.newTask")}
        </button>
      </div>

      {tasksQuery.isLoading ? (
        <div className="flex justify-center py-16 text-text-muted">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : tasks.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface-1/50 px-6 py-14 text-center">
          <Clock size={26} className="mx-auto mb-3 text-text-tertiary" />
          <div className="text-[13px] font-medium text-text-primary">
            {t("scheduledTasks.emptyTitle")}
          </div>
          <div className="mt-1 text-[12px] text-text-tertiary">
            {t("scheduledTasks.emptyDesc")}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div
              key={task.id}
              className="rounded-xl border border-border bg-surface-1 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14px] font-semibold text-text-primary">
                      {task.name}
                    </span>
                    {task.lastStatus ? (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          task.lastStatus === "success"
                            ? "bg-green-500/15 text-green-600"
                            : task.lastStatus === "error"
                              ? "bg-destructive/15 text-destructive"
                              : "bg-amber-500/15 text-amber-600"
                        }`}
                      >
                        {t(`scheduledTasks.status.${task.lastStatus}`)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 line-clamp-2 text-[12px] text-text-muted">
                    {task.instruction}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
                    <span className="inline-flex items-center gap-1">
                      <Clock size={11} />
                      {describeSchedule(task)}
                    </span>
                    <span>
                      {t("scheduledTasks.nextRun")}:{" "}
                      {formatDateTime(task.nextRunAt)}
                    </span>
                    <span>
                      {t("scheduledTasks.lastRun")}:{" "}
                      {formatDateTime(task.lastRunAt)}
                    </span>
                  </div>
                  {task.notifyChannelId ? (
                    <div className="mt-1 text-[11px] text-text-tertiary">
                      {t("scheduledTasks.notifiesChannel")}
                    </div>
                  ) : null}
                  {task.lastError ? (
                    <div className="mt-1 text-[11px] text-destructive">
                      {task.lastError}
                    </div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Switch
                    size="xs"
                    checked={task.enabled}
                    disabled={toggleMutation.isPending}
                    onCheckedChange={(checked) =>
                      toggleMutation.mutate({ id: task.id, enabled: checked })
                    }
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                <button
                  type="button"
                  disabled={runMutation.isPending}
                  onClick={() => runMutation.mutate(task.id)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-surface-2"
                >
                  <Play size={12} />
                  {t("scheduledTasks.runNow")}
                </button>
                <button
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (window.confirm(t("scheduledTasks.confirmDelete"))) {
                      deleteMutation.mutate(task.id);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 size={12} />
                  {t("scheduledTasks.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface-1 p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold text-text-primary">
                {t("scheduledTasks.newTask")}
              </h2>
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-text-secondary">
                  {t("scheduledTasks.field.name")}
                </span>
                <input
                  className={inputClass}
                  value={form.name}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, name: e.target.value }))
                  }
                  placeholder={t("scheduledTasks.field.namePlaceholder")}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-text-secondary">
                  {t("scheduledTasks.field.instruction")}
                </span>
                <textarea
                  className={`${inputClass} min-h-[80px] resize-y`}
                  value={form.instruction}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, instruction: e.target.value }))
                  }
                  placeholder={t("scheduledTasks.field.instructionPlaceholder")}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-text-secondary">
                  {t("scheduledTasks.field.frequency")}
                </span>
                <select
                  className={inputClass}
                  value={form.frequency}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      frequency: e.target.value as ScheduleFrequency,
                    }))
                  }
                >
                  {FREQUENCIES.map((freq) => (
                    <option key={freq} value={freq}>
                      {t(`scheduledTasks.frequency.${freq}`)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex flex-wrap gap-3">
                {showHour ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-text-secondary">
                      {t("scheduledTasks.field.hour")}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={23}
                      className={`${inputClass} w-24`}
                      value={form.hour}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          hour: Math.max(
                            0,
                            Math.min(23, Number(e.target.value) || 0),
                          ),
                        }))
                      }
                    />
                  </label>
                ) : null}
                {showMinute ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-text-secondary">
                      {t("scheduledTasks.field.minute")}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      className={`${inputClass} w-24`}
                      value={form.minute}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          minute: Math.max(
                            0,
                            Math.min(59, Number(e.target.value) || 0),
                          ),
                        }))
                      }
                    />
                  </label>
                ) : null}
                {showDayOfWeek ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-text-secondary">
                      {t("scheduledTasks.field.dayOfWeek")}
                    </span>
                    <select
                      className={inputClass}
                      value={form.dayOfWeek}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          dayOfWeek: Number(e.target.value),
                        }))
                      }
                    >
                      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
                        <option key={d} value={d}>
                          {t(`scheduledTasks.weekday.${d}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {showDayOfMonth ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-text-secondary">
                      {t("scheduledTasks.field.dayOfMonth")}
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      className={`${inputClass} w-24`}
                      value={form.dayOfMonth}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          dayOfMonth: Math.max(
                            1,
                            Math.min(31, Number(e.target.value) || 1),
                          ),
                        }))
                      }
                    />
                  </label>
                ) : null}
              </div>

              {bots.length > 0 ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-text-secondary">
                    {t("scheduledTasks.field.agent")}
                  </span>
                  <select
                    className={inputClass}
                    value={form.botId}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, botId: e.target.value }))
                    }
                  >
                    <option value="">
                      {t("scheduledTasks.field.defaultAgent")}
                    </option>
                    {bots.map((bot) => (
                      <option key={bot.id} value={bot.id}>
                        {bot.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}

              <label className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-text-secondary">
                  {t("scheduledTasks.field.notifyChannel")}
                </span>
                <select
                  className={inputClass}
                  value={form.notifyChannelId}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, notifyChannelId: e.target.value }))
                  }
                >
                  <option value="">
                    {t("scheduledTasks.field.noNotify")}
                  </option>
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.channelType}
                      {channel.teamName ? ` · ${channel.teamName}` : ""}
                    </option>
                  ))}
                </select>
              </label>

              {form.notifyChannelId ? (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-text-secondary">
                    {t("scheduledTasks.field.notifyTarget")}
                  </span>
                  <input
                    className={inputClass}
                    value={form.notifyTarget}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, notifyTarget: e.target.value }))
                    }
                    placeholder={t(
                      "scheduledTasks.field.notifyTargetPlaceholder",
                    )}
                  />
                  <span className="text-[11px] text-text-tertiary">
                    {t("scheduledTasks.field.notifyTargetHint")}
                  </span>
                </label>
              ) : null}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-border px-3 py-2 text-[13px] text-text-secondary hover:bg-surface-2"
              >
                {t("scheduledTasks.cancel")}
              </button>
              <button
                type="button"
                disabled={createMutation.isPending}
                onClick={handleCreate}
                className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-60"
              >
                {createMutation.isPending ? (
                  <Loader2 className="animate-spin" size={14} />
                ) : null}
                {t("scheduledTasks.create")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
