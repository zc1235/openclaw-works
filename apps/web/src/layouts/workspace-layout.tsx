import { BrandMark } from "@/components/brand-mark";
import { BudgetWarningBanner } from "@/components/budget-warning-banner";
import { PlatformIcon } from "@/components/platform-icons";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { useCloudConnect } from "@/hooks/use-cloud-connect";
import { useCommunitySkills } from "@/hooks/use-community-catalog";
import {
  getBudgetBannerRouteVariant,
  useDesktopBudgetGuard,
} from "@/hooks/use-desktop-budget-guard";
import { useDesktopCloudStatus } from "@/hooks/use-desktop-cloud-status";
import { useDesktopRewardsStatus } from "@/hooks/use-desktop-rewards";
import { authClient } from "@/lib/auth-client";
import {
  getSessionFolderUrl,
  openExternalUrl,
  openLocalFolderUrl,
} from "@/lib/desktop-links";
import {
  isMacDesktopPlatform,
  isWindowsDesktopPlatform,
} from "@/lib/desktop-platform";
import { logoutToWelcome } from "@/lib/logout";
import { normalizeChannel, track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Cable,
  ChevronRight,
  ChevronUp,
  Clock,
  FolderOpen,
  Info,
  Menu,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import "@/lib/api";
import { toast } from "sonner";
import {
  deleteApiV1SessionsById,
  getApiV1Me,
  getApiV1Sessions,
  getApiV1SessionsById,
} from "../../lib/api/sdk.gen";

interface SidebarSession {
  id: string;
  sessionKey: string;
  title: string;
  channelType: string;
  lastTime: string | null;
  status: string;
}

export function getSidebarCreditBreakdown(input: {
  progress: {
    earnedCredits: number;
  };
  cloudBalance: {
    totalBalance: number;
    giftedBalance?: number;
    planBalance?: number;
  } | null;
}) {
  if (!input.cloudBalance) {
    return {
      totalBalance: 0,
      giftedBalance: 0,
      planBalance: 0,
    };
  }

  const totalBalance = input.cloudBalance.totalBalance;
  const giftedBalance = Math.min(
    Math.max(input.cloudBalance.giftedBalance ?? 0, 0),
    totalBalance,
  );
  const planBalance =
    input.cloudBalance.planBalance ?? Math.max(totalBalance - giftedBalance, 0);

  return {
    totalBalance,
    giftedBalance,
    planBalance: Math.max(planBalance, 0),
  };
}

function mapDbSession(s: {
  id: string;
  sessionKey?: string | null;
  title: string;
  channelType?: string | null;
  lastMessageAt?: string | null;
  updatedAt?: string;
  status?: string | null;
}): SidebarSession {
  return {
    id: s.id,
    sessionKey: s.sessionKey ?? "",
    title: s.title,
    channelType: s.channelType ?? "web",
    lastTime: s.lastMessageAt ?? s.updatedAt ?? null,
    status: s.status ?? "",
  };
}

type Platform =
  | "slack"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "feishu"
  | "dingtalk"
  | "wecom"
  | "qqbot"
  | "wechat"
  | "openclaw-weixin"
  | "web";

const PLATFORM_LABELS: Record<Platform, string> = {
  discord: "Discord",
  slack: "Slack",
  feishu: "Feishu",
  dingtalk: "DingTalk",
  wecom: "WeCom",
  qqbot: "QQ",
  wechat: "WeChat",
  "openclaw-weixin": "WeChat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  web: "Web",
};

function SidebarPlatformIcon({ platform }: { platform: string }) {
  return (
    <span className="flex justify-center items-center w-7 h-7 rounded-xl border border-border bg-surface-1 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <PlatformIcon platform={platform} size={15} />
    </span>
  );
}

function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as Platform] ?? "Web";
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function EmptyState({ onGoConfig }: { onGoConfig: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col justify-center items-center h-full px-8">
      <div className="max-w-md text-center">
        <div className="flex justify-center items-center mx-auto mb-6 w-16 h-16 rounded-2xl bg-accent/10">
          <MessageSquare size={28} className="text-accent" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-text-primary">
          {t("layout.empty.title")}
        </h2>
        <p className="mb-6 text-sm leading-relaxed text-text-muted">
          {t("layout.empty.description")}
        </p>
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            onClick={onGoConfig}
            className="flex gap-2 items-center px-6 py-2.5 text-sm font-medium text-white rounded-lg transition-colors bg-accent hover:bg-accent-hover"
          >
            <Settings size={14} /> {t("layout.empty.setupBot")}
          </button>
          <div className="flex gap-4 mt-2">
            {[
              { step: "1", text: t("layout.empty.step1") },
              { step: "2", text: t("layout.empty.step2") },
              { step: "3", text: t("layout.empty.step3") },
            ].map((s, i) => (
              <div
                key={s.step}
                className="flex gap-1.5 items-center text-[12px] text-text-muted"
              >
                {i > 0 && <span className="text-border mr-1">→</span>}
                <span className="flex justify-center items-center w-4 h-4 rounded-full bg-accent/10 text-[10px] font-semibold text-accent">
                  {s.step}
                </span>
                {s.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// SETUP_COMPLETE_KEY previously gated the workspace behind an onboarding
// flow that no longer exists after nexu accounts were removed. The
// localStorage key itself may still be present from older installs and is
// harmless — nothing reads it now.
function resolveCloudUsageUrl(cloudUrl?: string | null): string {
  if (!cloudUrl) return "https://nexu.io/workspace/usage";
  try {
    const origin = new URL(cloudUrl).origin;
    return `${origin}/workspace/usage`;
  } catch {
    return "https://nexu.io/workspace/usage";
  }
}

function SidebarSessionRow({
  session,
  isActive,
  onOpen,
}: {
  session: SidebarSession;
  isActive: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const handleOpenWorkspace = async () => {
    setMenuOpen(false);
    try {
      const { data } = await getApiV1SessionsById({
        path: { id: session.id },
      });
      const folderUrl = getSessionFolderUrl(
        (data?.metadata as Record<string, unknown> | null | undefined) ?? null,
      );
      if (!folderUrl) {
        toast.error(t("layout.session.workspaceUnavailable"));
        return;
      }
      await openLocalFolderUrl(folderUrl);
    } catch {
      toast.error(t("layout.session.workspaceUnavailable"));
    }
  };

  const handleDelete = async () => {
    setMenuOpen(false);
    try {
      await deleteApiV1SessionsById({ path: { id: session.id } });
      await queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      await queryClient.invalidateQueries({ queryKey: ["sessions"] });
      if (isActive) {
        navigate("/workspace/chat");
      }
      toast.success(t("layout.session.deleted"));
    } catch {
      toast.error(t("layout.session.deleteFailed"));
    }
  };

  return (
    <div
      className={cn(
        "group relative flex items-center rounded-[10px] transition-colors",
        isActive && "nav-item-active",
      )}
      data-sidebar-session-row={session.id}
      data-session-channel-type={session.channelType ?? "web"}
      data-session-state={session.status || "idle"}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex flex-1 min-w-0 items-center gap-2.5 cursor-pointer px-3 py-2 text-left"
      >
        <SidebarPlatformIcon platform={session.channelType ?? "web"} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div
              className={cn(
                "text-[12px] truncate whitespace-nowrap font-medium",
                !isActive && "text-text-primary",
              )}
            >
              {session.title}
            </div>
            {session.status === "active" && (
              <span className="shrink-0 rounded-full bg-[var(--color-success-subtle)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-success)]">
                Live
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate whitespace-nowrap">
            <span>{getPlatformLabel(session.channelType ?? "web")}</span>
            <span className="text-border">·</span>
            <span>{formatTime(session.lastTime)}</span>
          </div>
        </div>
      </button>
      <div className="relative mr-1 shrink-0" ref={menuRef}>
        <button
          type="button"
          aria-label={t("layout.session.moreActions")}
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((prev) => !prev);
          }}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary",
            menuOpen ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          <MoreHorizontal size={14} />
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-xl border border-border bg-surface-1 shadow-xl shadow-black/10">
            <div className="p-1.5">
              <button
                type="button"
                onClick={() => void handleOpenWorkspace()}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] font-medium text-text-secondary transition-all hover:bg-surface-2 hover:text-text-primary"
              >
                <FolderOpen size={14} />
                {t("layout.session.openWorkspace")}
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-[12px] font-medium text-text-muted transition-all hover:bg-red-500/5 hover:text-red-500"
              >
                <Trash2 size={13} />
                {t("layout.session.delete")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface UpdateFloatCardProps {
  phase: ReturnType<typeof useAutoUpdate>["phase"];
  version: string | null;
  percent: number;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
  t: (key: string, options?: Record<string, string>) => string;
  desktopOffsetLeft: number;
  desktopOffsetBottom: number;
  width: number;
}

function UpdateFloatCard({
  phase,
  version,
  percent,
  onDownload,
  onInstall,
  onDismiss,
  t,
  desktopOffsetLeft,
  desktopOffsetBottom,
  width,
}: UpdateFloatCardProps) {
  const updating = phase === "downloading" || phase === "installing";
  const downloadProgress = Math.round(percent);

  if (
    phase !== "available" &&
    phase !== "downloading" &&
    phase !== "installing" &&
    phase !== "ready"
  ) {
    return null;
  }

  return (
    <div
      className="fixed z-50 rounded-[14px] border border-border bg-surface-0/88 px-3.5 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop-blur-md animate-float"
      style={
        {
          left: desktopOffsetLeft,
          bottom: desktopOffsetBottom,
          width,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative mt-0.5 flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-success)] opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" />
            </span>
            <span className="text-[12px] font-medium text-text-primary">
              {phase === "installing"
                ? t("layout.update.installing")
                : updating
                  ? t("layout.update.downloading")
                  : phase === "ready"
                    ? t("layout.update.readyToInstall")
                    : t("layout.update.available", {
                        version: version ?? "",
                      })}
            </span>
          </div>
        </div>
        {!updating && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-text-muted hover:text-text-primary transition-colors -mr-1"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {updating && (
        <div className="flex items-center justify-between mt-3 mb-1">
          <span className="text-[10px] tabular-nums text-text-muted">
            {phase === "installing" ? "…" : `${downloadProgress}%`}
          </span>
        </div>
      )}
      {updating ? (
        <div>
          <div className="h-[6px] w-full rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--color-brand-primary)] transition-all duration-300 ease-out"
              style={{
                width: phase === "installing" ? "100%" : `${downloadProgress}%`,
              }}
            />
          </div>
        </div>
      ) : phase === "ready" ? (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onInstall}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.install")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            {t("layout.update.later")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onDownload}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.download")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            {t("layout.update.later")}
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceLayout() {
  // Nexu accounts have been removed, so there is no longer a welcome /
  // onboarding page to gate the workspace behind. Rendering directly avoids
  // an infinite redirect loop between "/" (which itself points at
  // /workspace/chat now) and this layout, which otherwise sends the user
  // back to "/" forever on a fresh install where SETUP_COMPLETE_KEY is
  // never set.
  return <WorkspaceLayoutInner />;
}

function WorkspaceLayoutInner() {
  const { t } = useTranslation();
  const isDesktopClient = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron"),
    [],
  );
  const [collapsed, setCollapsed] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const {
    status: rewardsStatus,
    loading: rewardsStatusLoading,
    resolved: rewardsStatusResolved,
  } = useDesktopRewardsStatus();
  const update = useAutoUpdate();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const queryClient = useQueryClient();
  const hasUpdate =
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "installing" ||
    update.phase === "ready";
  const SIDEBAR_MIN = 160;
  const SIDEBAR_MAX = 320;
  const SIDEBAR_DEFAULT = 192;
  const MAIN_MIN = 480;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("nexu_sidebar_width");
    return saved
      ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved)))
      : SIDEBAR_DEFAULT;
  });
  const isResizing = useRef(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const containerWidth = window.innerWidth;
        const newW = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)),
        );
        if (containerWidth - newW >= MAIN_MIN) {
          setSidebarWidth(newW);
        }
      };

      const onUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarWidth((w) => {
          localStorage.setItem("nexu_sidebar_width", String(w));
          return w;
        });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const [showBalancePopup, setShowBalancePopup] = useState(false);
  const logoutRef = useRef<HTMLDivElement>(null);
  const balanceRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();
  const { data: skillsData } = useCommunitySkills();
  const {
    data: desktopCloudStatus,
    isLoading: cloudStatusLoading,
    refetch: refetchDesktopCloudStatus,
  } = useDesktopCloudStatus();
  const installedSkillsCount = skillsData?.installedSkills?.length ?? 0;
  const cloudConnected = desktopCloudStatus?.connected ?? false;
  const { cloudConnecting, handleCloudConnect } = useCloudConnect({
    cloudConnected,
    onPoll: refetchDesktopCloudStatus,
  });

  useEffect(() => {
    track("workspace_view");
  }, []);

  useEffect(() => {
    if (!isDesktopClient) {
      return;
    }

    const root = document.getElementById("root");
    const previousHtmlBackground =
      document.documentElement.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousRootBackground = root?.style.backgroundColor ?? "";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    if (root) {
      root.style.backgroundColor = "transparent";
    }

    return () => {
      document.documentElement.style.backgroundColor = previousHtmlBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      if (root) {
        root.style.backgroundColor = previousRootBackground;
      }
    };
  }, [isDesktopClient]);

  useEffect(() => {
    if (!showLogoutConfirm) return;
    const handler = (e: MouseEvent) => {
      if (logoutRef.current && !logoutRef.current.contains(e.target as Node)) {
        setShowLogoutConfirm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLogoutConfirm]);

  useEffect(() => {
    if (!showBalancePopup) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const portalEl = document.querySelector(
        "[data-sidebar-rewards-balance-popup]",
      );
      if (
        balanceRef.current &&
        !balanceRef.current.contains(target) &&
        (!portalEl || !portalEl.contains(target))
      ) {
        setShowBalancePopup(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBalancePopup]);

  useEffect(() => {
    if (!mobileDrawerOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [mobileDrawerOpen]);

  const { data: sessionsData } = useQuery({
    queryKey: ["sidebar-sessions"],
    queryFn: async (): Promise<SidebarSession[]> => {
      const { data } = await getApiV1Sessions({ query: { limit: 100 } });
      return (data?.sessions ?? []).map(mapDbSession);
    },
    refetchInterval: 10_000,
  });
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data } = await getApiV1Me();
      return data;
    },
  });

  const sessions = sessionsData ?? [];

  const sessionMatch = location.pathname.match(/\/workspace\/sessions\/(.+)/);
  const selectedSessionId = sessionMatch?.[1] ?? null;
  const chatMatch = location.pathname.match(/\/workspace\/chat\/(.+)/);
  const selectedChatKey = chatMatch?.[1] ?? null;
  const isHomePage =
    location.pathname === "/workspace" ||
    location.pathname === "/workspace/home";
  const isRewardsPage = location.pathname.includes("/rewards");
  const isSkillsPage = location.pathname.includes("/skills");
  const isModelsPage =
    location.pathname.includes("/models") ||
    location.pathname.includes("/settings");
  const isChatPage = location.pathname.startsWith("/workspace/chat");
  const isChannelsPage = location.pathname.startsWith("/workspace/channels");
  const isScheduledTasksPage = location.pathname.startsWith(
    "/workspace/scheduled-tasks",
  );
  const isIntegrationsPage = location.pathname.startsWith(
    "/workspace/integrations",
  );

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    track("workspace_logout_click");
    await logoutToWelcome({ queryClient });
  };

  const userEmail = me?.email ?? session?.user?.email ?? "";
  const userName = me?.name?.trim() || session?.user?.name || userEmail;
  const userImage = me?.image ?? session?.user?.image ?? null;
  const userInitial = (userName[0] ?? userEmail[0] ?? "U").toUpperCase();
  const rewardsBalancePending =
    cloudConnected &&
    !rewardsStatus.cloudBalance &&
    (rewardsStatusLoading || !rewardsStatusResolved);
  const canOpenBalancePopup =
    cloudConnected || rewardsStatus.cloudBalance !== null;
  const rewardBalanceValue = rewardsStatus.cloudBalance
    ? `${rewardsStatus.cloudBalance.totalBalance} ${t("layout.sidebar.balanceUnit")}`
    : cloudConnected
      ? rewardsBalancePending
        ? t("layout.sidebar.balancePlaceholder")
        : `0 ${t("layout.sidebar.balanceUnit")}`
      : t("layout.sidebar.balancePlaceholder");
  const rewardBalancePopupValue = rewardsStatus.cloudBalance
    ? String(rewardsStatus.cloudBalance.totalBalance)
    : rewardBalanceValue;
  const sidebarCreditBreakdown = getSidebarCreditBreakdown({
    progress: rewardsStatus.progress,
    cloudBalance: rewardsStatus.cloudBalance,
  });
  const shouldShowRewardsBanner =
    cloudConnected &&
    rewardsStatus.progress.totalCount > 0 &&
    rewardsStatus.progress.claimedCount < rewardsStatus.progress.totalCount;
  const rewardsCardLoading =
    cloudStatusLoading && desktopCloudStatus === undefined;
  const { bannerDismissible, budgetStatus, dismissBanner, shouldShowPrompt } =
    useDesktopBudgetGuard({
      pathname: location.pathname,
      cloudConnected,
    });
  const budgetBannerRouteVariant = getBudgetBannerRouteVariant(
    location.pathname,
  );

  // Legacy empty-state (which used to prompt users to configure an IM bot
  // before the workspace was useful) is removed. Every page now renders its
  // own content and manages its own empty presentation — the Outlet is
  // rendered unconditionally.
  const selectedSession = selectedSessionId
    ? sessions.find((s) => s.id === selectedSessionId)
    : null;
  const mobileTitle = isHomePage
    ? t("layout.mobile.home")
    : isRewardsPage
      ? t("layout.mobile.rewards")
      : isSkillsPage
        ? t("layout.mobile.skills")
        : isModelsPage
          ? t("layout.mobile.settings")
          : selectedSession?.title || t("layout.mobile.conversations");
  const mobileSubtitle = isHomePage
    ? t("layout.mobile.homeSubtitle")
    : isRewardsPage
      ? t("layout.mobile.rewardsSubtitle")
      : isSkillsPage
        ? t("layout.mobile.skillsSubtitle")
        : isModelsPage
          ? t("layout.mobile.settingsSubtitle")
          : selectedSession
            ? `${getPlatformLabel(selectedSession.channelType)} · ${formatTime(selectedSession.lastTime)}`
            : `${sessions.length} conversation${sessions.length === 1 ? "" : "s"}`;
  const isWindowsDesktopClient = isDesktopClient && isWindowsDesktopPlatform();
  const isMacDesktopClient = isDesktopClient && isMacDesktopPlatform();
  const desktopGlassTint = isWindowsDesktopClient
    ? "#ffffff"
    : "rgba(255, 255, 255, 0.08)";
  const updateFloatWidth = 288;
  const updateFloatLeft = 10;
  const updateFloatBottom = 52;

  return (
    <div
      className="flex h-screen relative overflow-hidden"
      style={
        isDesktopClient
          ? ({ background: desktopGlassTint } as React.CSSProperties)
          : undefined
      }
    >
      {!isDesktopClient && hasUpdate && !updateDismissed && (
        <UpdateFloatCard
          phase={update.phase}
          version={update.version}
          percent={update.percent}
          onDownload={() => update.download()}
          onInstall={() => update.install()}
          onDismiss={() => setUpdateDismissed(true)}
          t={t}
          desktopOffsetLeft={updateFloatLeft}
          desktopOffsetBottom={updateFloatBottom}
          width={updateFloatWidth}
        />
      )}

      {/* Mac sidebar toggle — fixed next to traffic lights, always visible */}
      {isMacDesktopClient && (
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="fixed top-[10px] left-[76px] h-8 w-8 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors hidden md:flex items-center justify-center z-50"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={
            collapsed ? t("layout.expandSidebar") : t("layout.collapseSidebar")
          }
        >
          {collapsed ? (
            <PanelLeftOpen size={16} />
          ) : (
            <PanelLeftClose size={16} />
          )}
        </button>
      )}
      {/* Non-mac, non-windows collapsed toggle */}
      {!isMacDesktopClient && !isWindowsDesktopClient && collapsed && (
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="fixed top-[16px] left-[24px] h-8 w-8 rounded-lg text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors hidden md:flex items-center justify-center z-50"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          title={t("layout.expandSidebar")}
        >
          <PanelLeftOpen size={16} />
        </button>
      )}

      {isWindowsDesktopClient && (
        <div className="fixed px-2 z-50">
          <div className="px-2.5 h-8 flex items-center">
            {collapsed ? (
              <PanelLeftOpen
                onClick={() => setCollapsed(!collapsed)}
                size={16}
              />
            ) : (
              <PanelLeftClose
                onClick={() => setCollapsed(!collapsed)}
                size={16}
              />
            )}
          </div>
        </div>
      )}

      {/* Desktop sidebar — transparent bg, no border (matches design-system) */}
      <div
        className={`hidden md:flex flex-col shrink-0 overflow-hidden ${collapsed ? "w-0" : ""}`}
        style={
          {
            ...(!collapsed ? { width: sidebarWidth } : {}),
            transition: isResizing.current ? "none" : "width 200ms",
            WebkitAppRegion: "drag",
            background: isDesktopClient ? desktopGlassTint : "transparent",
          } as React.CSSProperties
        }
      >
        {/* Traffic light clearance (desktop client) */}
        {!isWindowsDesktopClient && <div className={cn("shrink-0", "h-14")} />}

        {/* Header / Brand */}
        {!isWindowsDesktopClient && (
          <div
            className={cn(
              "flex items-center justify-between px-3 pb-2 shrink-0",
              isMacDesktopClient && "px-4 pb-1",
              !isDesktopClient && "border-b border-border py-3 px-4 gap-2.5",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {isDesktopClient ? (
              <>
                <span className="text-[15px] font-semibold text-text-primary whitespace-nowrap">
                  灵光办公助手
                </span>
                <div className="flex items-center gap-2">
                  {hasUpdate && updateDismissed && (
                    <button
                      type="button"
                      onClick={() => setUpdateDismissed(false)}
                      className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[var(--color-brand-primary)] text-white hover:opacity-85 transition-opacity"
                    >
                      {t("layout.update.badge")}
                    </button>
                  )}
                  {!isMacDesktopClient && (
                    <button
                      type="button"
                      onClick={() => setCollapsed(true)}
                      className="p-1.5 rounded-lg transition-colors text-text-muted hover:text-text-primary hover:bg-surface-3 shrink-0"
                      title={t("layout.collapseSidebar")}
                    >
                      <PanelLeftClose size={14} />
                    </button>
                  )}
                </div>
              </>
            ) : (
              <>
                <BrandMark className="w-7 h-7 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-text-primary whitespace-nowrap">
                    灵光办公助手
                  </div>
                  <div className="text-[10px] text-text-tertiary whitespace-nowrap">
                    {t("layout.brand")}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {isWindowsDesktopClient && <div className="h-8 shrink-0" />}

        {/* Main nav + conversations */}
        <div
          className="flex-1 overflow-y-auto"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/* Nav items — chat/new-task at top, then skills, channels, integrations, models */}
          <div className="px-2 pt-3 pb-1">
            <Link
              to="/workspace/chat"
              onClick={() => {
                track("workspace_sidebar_click", { target: "chat" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isChatPage && "nav-item-active",
              )}
            >
              <MessageSquare size={16} className="shrink-0" />
              {t("layout.nav.newTask")}
            </Link>
            <Link
              to="/workspace/skills"
              onClick={() => {
                track("workspace_skills_click");
                track("workspace_sidebar_click", { target: "skills" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isSkillsPage && "nav-item-active",
              )}
            >
              <Sparkles size={16} className="shrink-0" />
              {t("layout.nav.skills")}
              {installedSkillsCount > 0 && (
                <span className="ml-auto text-[10px] text-text-tertiary font-normal">
                  {installedSkillsCount}
                </span>
              )}
            </Link>
            <Link
              to="/workspace/channels"
              onClick={() => {
                track("workspace_sidebar_click", { target: "channels" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isChannelsPage && "nav-item-active",
              )}
            >
              <Cable size={16} className="shrink-0" />
              {t("layout.nav.channels")}
            </Link>
            <Link
              to="/workspace/scheduled-tasks"
              onClick={() => {
                track("workspace_sidebar_click", { target: "scheduled-tasks" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isScheduledTasksPage && "nav-item-active",
              )}
            >
              <Clock size={16} className="shrink-0" />
              {t("layout.nav.scheduledTasks")}
            </Link>
            <Link
              to="/workspace/integrations"
              onClick={() => {
                track("workspace_sidebar_click", { target: "integrations" });
              }}
              className={cn(
                "nav-item flex items-center gap-2.5 w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 px-3 py-2 whitespace-nowrap",
                isIntegrationsPage && "nav-item-active",
              )}
            >
              <BookOpen size={16} className="shrink-0" />
              {t("layout.nav.integrations")}
            </Link>
          </div>

          {/* Conversations section */}
          <div className="px-2 pt-6">
            <div className="sidebar-section-label whitespace-nowrap">
              {t("layout.conversations")}
            </div>
            <div className="space-y-0.5">
              {sessions.map((s) => {
                // Desktop chats (New Task) reopen in the interactive chat view;
                // IM sessions open the read-only transcript.
                const isDesktopChat =
                  s.channelType === "desktop" && s.sessionKey.length > 0;
                const isActive = isDesktopChat
                  ? selectedChatKey === s.sessionKey
                  : selectedSessionId === s.id;
                return (
                  <SidebarSessionRow
                    key={s.id}
                    session={s}
                    isActive={isActive}
                    onOpen={() => {
                      const channel = normalizeChannel(s.channelType);
                      track("workspace_channel_click", {
                        channel_type: s.channelType,
                      });
                      track("workspace_sidebar_click", {
                        target: "conversations",
                        ...(channel ? { channel } : {}),
                      });
                      if (isDesktopChat) {
                        navigate(`/workspace/chat/${s.sessionKey}`);
                      } else {
                        navigate(`/workspace/sessions/${s.id}`);
                      }
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        {/* Sidebar growth card — removed with nexu accounts */}
        {null}


        {/* Bottom action row */}
        <div
          className="shrink-0 border-t border-border/60 pt-1.5 pb-2 px-2 flex items-center gap-0.5"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              track("workspace_settings_click");
              track("workspace_sidebar_click", { target: "settings_footer" });
              navigate("/workspace/settings");
            }}
            title={t("layout.nav.settings")}
            className={cn(
              "nav-item flex flex-1 min-w-0 items-center gap-2 rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer px-2.5 py-2",
              isModelsPage && "nav-item-active",
            )}
          >
            <Settings size={16} className="shrink-0" />
            <span className="truncate text-left">
              {t("layout.nav.settings")}
            </span>
          </button>
        </div>

        {/* Account block — removed with nexu accounts */}
      </div>

      {/* Mobile drawer */}
      {mobileDrawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/30"
            onClick={() => {
              setMobileDrawerOpen(false);
              setShowLogoutConfirm(false);
            }}
          />
          <div className="absolute inset-y-0 left-0 w-[84%] max-w-[320px] sidebar-vibrancy border-r border-border shadow-xl">
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <div className="flex items-center gap-2.5 min-w-0">
                  <BrandMark className="w-7 h-7 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-text-primary truncate">
                      灵光办公助手
                    </div>
                    <div className="text-[10px] text-text-tertiary">
                      {t("layout.brand")}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setMobileDrawerOpen(false)}
                  className="p-1.5 rounded-lg transition-colors text-text-muted hover:text-text-primary hover:bg-surface-3"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto">
                {/* Nav items */}
                <div className="px-3 pt-3 pb-1">
                  <Link
                    to="/workspace/chat"
                    onClick={() => {
                      track("workspace_sidebar_click", { target: "chat" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isChatPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <MessageSquare size={14} />
                    {t("layout.nav.newTask")}
                  </Link>
                  <Link
                    to="/workspace/channels"
                    onClick={() => {
                      track("workspace_sidebar_click", {
                        target: "channels_mobile",
                      });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isChannelsPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <Cable size={14} />
                    {t("layout.nav.channels")}
                  </Link>
                  <Link
                    to="/workspace/skills"
                    onClick={() => {
                      track("workspace_skills_click");
                      track("workspace_sidebar_click", { target: "skills" });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isSkillsPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Sparkles size={14} />
                      {t("layout.nav.skills")}
                    </span>
                  </Link>
                  <Link
                    to="/workspace/settings"
                    onClick={() => {
                      track("workspace_settings_click");
                      track("workspace_sidebar_click", {
                        target: "settings_mobile",
                      });
                      setMobileDrawerOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 w-full rounded-lg text-[12px] font-medium transition-colors cursor-pointer mt-0.5 px-3 py-2",
                      isModelsPage
                        ? "bg-accent/10 text-accent"
                        : "text-text-muted hover:text-text-primary hover:bg-surface-3",
                    )}
                  >
                    <Settings size={14} />
                    {t("layout.nav.settings")}
                  </Link>
                </div>

                {/* Conversations section */}
                <div className="px-3 pt-2 pb-3">
                  <div className="border-t border-border pt-2 mb-1.5" />
                  <div className="px-3 mb-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider">
                    {t("layout.conversations")}
                  </div>
                  <div className="space-y-0.5">
                    {sessions.map((s) => {
                      const isActive = selectedSessionId === s.id;
                      return (
                        <button
                          type="button"
                          key={s.id}
                          data-sidebar-session-row={s.id}
                          data-session-channel-type={s.channelType ?? "web"}
                          data-session-state={s.status || "idle"}
                          onClick={() => {
                            const channel = normalizeChannel(s.channelType);
                            track("workspace_channel_click", {
                              channel_type: s.channelType,
                            });
                            track("workspace_sidebar_click", {
                              target: "conversations",
                              ...(channel ? { channel } : {}),
                            });
                            setMobileDrawerOpen(false);
                            navigate(`/workspace/sessions/${s.id}`);
                          }}
                          className={cn(
                            "flex items-center gap-2.5 w-full rounded-[10px] transition-colors cursor-pointer px-2.5 py-2 text-left",
                            isActive
                              ? "bg-accent/10 text-accent"
                              : "text-text-secondary hover:text-text-primary hover:bg-surface-3",
                          )}
                        >
                          <SidebarPlatformIcon
                            platform={s.channelType ?? "web"}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="text-[13px] truncate font-medium">
                                {s.title}
                              </div>
                              {s.status === "active" && (
                                <span className="shrink-0 rounded-full bg-[var(--color-success-subtle)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-success)]">
                                  Live
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate">
                              <span>
                                {getPlatformLabel(s.channelType ?? "web")}
                              </span>
                              <span className="text-border">·</span>
                              <span>{formatTime(s.lastTime)}</span>
                            </div>
                          </div>
                          {s.status === "active" ? (
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-[var(--color-success)]" />
                          ) : (
                            <div className="w-1.5 h-1.5 rounded-full shrink-0 bg-text-muted/30" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Mobile user menu — removed with nexu accounts */}
            </div>
          </div>
        </div>
      )}

      {/* Resize handle */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="hidden md:block w-px shrink-0 cursor-col-resize group relative z-10"
          style={
            {
              WebkitAppRegion: "no-drag",
              background: desktopGlassTint,
            } as React.CSSProperties
          }
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
      )}

      {/* Main content — elevated surface with rounded left edge */}
      <div className="relative flex-1 min-w-0">
        <div
          className={cn(
            "relative flex h-full min-w-0 flex-col bg-surface-1 rounded-l-[12px]",
          )}
        >
          <div className="md:hidden sticky top-0 z-30 border-b border-border bg-surface-0/95 backdrop-blur px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(true)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2 hover:text-text-primary"
                aria-label="Open menu"
              >
                <Menu size={16} />
              </button>
              <div className="min-w-0 flex-1 text-center leading-tight">
                <div className="text-[13px] font-semibold text-text-primary truncate">
                  {mobileTitle}
                </div>
                <div className="text-[10px] text-text-muted truncate mt-0.5">
                  {mobileSubtitle}
                </div>
              </div>
              <div className="w-9" />
            </div>
          </div>

          <main className="flex-1 overflow-y-auto min-h-0">
            {budgetBannerRouteVariant === "global" &&
            shouldShowPrompt &&
            budgetStatus !== "healthy" ? (
              <div className="mx-auto max-w-4xl px-4 pb-0 pt-4 sm:px-6 md:px-8">
                <BudgetWarningBanner
                  status={budgetStatus}
                  dismissible={bannerDismissible}
                  onDismiss={dismissBanner}
                />
              </div>
            ) : null}
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
