import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AuthLayout } from "./layouts/auth-layout";
import { InviteGuardLayout } from "./layouts/invite-guard-layout";
import { WorkspaceLayout } from "./layouts/workspace-layout";
import { ChannelsPage } from "./pages/channels";
import { CommunitySkillDetailPage } from "./pages/community-skill-detail";
import { DesktopChatPage } from "./pages/desktop-chat";
import { FeishuBindPage } from "./pages/feishu-bind";
import { IntegrationsPage } from "./pages/integrations";
import { ModelsPage } from "./pages/models";
import { OAuthCallbackPage } from "./pages/oauth-callback";
import { SessionsPage } from "./pages/sessions";
import { SkillsPage } from "./pages/skills";
import { SlackOAuthCallbackPage } from "./pages/slack-oauth-callback";

function DocumentTitleSync() {
  const location = useLocation();
  const { t } = useTranslation();

  useEffect(() => {
    const titleByPathname: Record<string, string> = {
      "/workspace": t("title.desktopChat"),
      "/workspace/home": t("title.desktopChat"),
      "/workspace/chat": t("title.desktopChat"),
      "/workspace/channels": t("title.channels"),
      "/workspace/integrations": t("title.integrations"),
      "/workspace/skills": t("title.skills"),
      "/workspace/settings": t("title.settings"),
      "/workspace/models": t("title.settings"),
      "/feishu/bind": t("title.linkFeishu"),
    };

    if (location.pathname.startsWith("/workspace/oauth-callback")) {
      document.title = t("title.connecting");
      return;
    }

    document.title = titleByPathname[location.pathname] ?? t("title.default");
  }, [location.pathname, t]);

  return null;
}

export function App() {
  return (
    <>
      <DocumentTitleSync />
      <Routes>
        {/*
         * Nexu accounts have been removed. The historical Welcome / Slack
         * claim / rewards flows are no longer reachable; visiting "/"
         * now drops the user straight into the "New task" (desktop chat)
         * page. The legacy routes are still importable in case a saved
         * shortcut points at them, but they redirect to the workspace.
         */}
        <Route path="/" element={<Navigate to="/workspace/chat" replace />} />
        <Route
          path="/claim"
          element={<Navigate to="/workspace/chat" replace />}
        />
        <Route path="/feishu/bind" element={<FeishuBindPage />} />
        <Route element={<AuthLayout />}>
          <Route element={<InviteGuardLayout />}>
            <Route
              path="/workspace/oauth-callback/:integrationId"
              element={<OAuthCallbackPage />}
            />
            <Route element={<WorkspaceLayout />}>
              <Route
                path="/workspace"
                element={<Navigate to="/workspace/chat" replace />}
              />
              <Route
                path="/workspace/home"
                element={<Navigate to="/workspace/chat" replace />}
              />
              <Route path="/workspace/chat" element={<DesktopChatPage />} />
              <Route
                path="/workspace/chat/:id"
                element={<DesktopChatPage />}
              />
              <Route path="/workspace/sessions" element={<SessionsPage />} />
              <Route
                path="/workspace/sessions/:id"
                element={<SessionsPage />}
              />
              <Route path="/workspace/channels" element={<ChannelsPage />} />
              <Route
                path="/workspace/integrations"
                element={<IntegrationsPage />}
              />
              <Route
                path="/workspace/rewards"
                element={<Navigate to="/workspace/chat" replace />}
              />
              <Route path="/workspace/settings" element={<ModelsPage />} />
              <Route path="/workspace/models" element={<ModelsPage />} />
              <Route path="/workspace/skills" element={<SkillsPage />} />
              <Route
                path="/workspace/skills/:slug"
                element={<CommunitySkillDetailPage />}
              />
              <Route
                path="/workspace/channels/slack/callback"
                element={<SlackOAuthCallbackPage />}
              />
            </Route>
          </Route>
        </Route>
        <Route
          path="*"
          element={<Navigate to="/workspace/chat" replace />}
        />
      </Routes>
    </>
  );
}
