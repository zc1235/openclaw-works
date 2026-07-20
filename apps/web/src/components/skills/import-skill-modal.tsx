import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useImportSkill,
  useImportSkillFolder,
} from "@/hooks/use-community-catalog";
import { track } from "@/lib/tracking";
import { AlertCircle, CheckCircle2, FolderOpen, Lock } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createAutoCloseController,
  getSelectedZipFile,
} from "./import-skill-modal-state";

type ImportTab = "zip" | "folder" | "github";

type SkillFolderPickerBridge = {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
};

async function pickSkillFolder(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const host = (window as Window & { nexuHost?: unknown }).nexuHost as
    | SkillFolderPickerBridge
    | undefined;
  if (!host || typeof host.invoke !== "function") return null;
  try {
    const result = (await host.invoke(
      "desktop:pick-skill-folder",
      undefined,
    )) as { path?: string | null } | null;
    return result?.path ?? null;
  } catch {
    return null;
  }
}

interface ImportSkillModalProps {
  open: boolean;
  onClose: () => void;
}

export default function ImportSkillModal({
  open,
  onClose,
}: ImportSkillModalProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ImportTab>("zip");
  const [dragOver, setDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [done, setDone] = useState(false);
  const [folderPath, setFolderPath] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoCloseControllerRef = useRef(createAutoCloseController());
  const importMutation = useImportSkill();
  const folderImportMutation = useImportSkillFolder();

  const reset = useCallback(() => {
    autoCloseControllerRef.current.cancel();
    setTab("zip");
    setDragOver(false);
    setSelectedFile(null);
    setFolderPath("");
    setDone(false);
    importMutation.reset();
    folderImportMutation.reset();
  }, [importMutation, folderImportMutation]);

  useEffect(() => {
    return () => {
      autoCloseControllerRef.current.cancel();
    };
  }, []);

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setSelectedFile(getSelectedZipFile(file));
    // Reset input so the same file can be re-selected
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    setSelectedFile(getSelectedZipFile(file));
  };

  const handleBrowseFolder = async () => {
    const picked = await pickSkillFolder();
    if (picked) {
      setFolderPath(picked);
      folderImportMutation.reset();
    }
  };

  const finishSuccess = (slug: string | undefined) => {
    track("workspace_skill_install", {
      skill_name: slug ?? "unknown_skill",
      skill_source: "custom",
      success: true,
    });
    track("workspace_skill_enable", {
      name: slug ?? "unknown_skill",
      skill_source: "custom",
    });
    setDone(true);
    autoCloseControllerRef.current.schedule(handleClose, 1200);
  };

  const handleImport = async () => {
    if (tab === "folder") {
      if (!folderPath) return;
      try {
        const result = await folderImportMutation.mutateAsync(folderPath);
        finishSuccess(result.slug);
      } catch {
        track("workspace_skill_install", {
          skill_name: "unknown_skill",
          skill_source: "custom",
          success: false,
        });
      }
      return;
    }

    if (!selectedFile) return;
    try {
      const result = await importMutation.mutateAsync(selectedFile);
      finishSuccess(result.slug);
    } catch {
      track("workspace_skill_install", {
        skill_name: "unknown_skill",
        skill_source: "custom",
        success: false,
      });
      // Error state handled by mutation
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-[16px]">
            {t("skills.importSkill")}
          </DialogTitle>
          <DialogDescription>{t("skills.importSkillDesc")}</DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => {
            setTab(v as ImportTab);
            setDone(false);
            importMutation.reset();
          }}
          className="px-6 pt-4"
        >
          <TabsList className="inline-flex h-9 bg-surface-2 p-1 gap-1 rounded-full">
            <TabsTrigger
              value="zip"
              className="rounded-full px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-all data-[state=active]:bg-white data-[state=active]:text-text-primary data-[state=active]:shadow-sm"
            >
              {t("skills.uploadZip")}
            </TabsTrigger>
            <TabsTrigger
              value="folder"
              className="rounded-full px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-all data-[state=active]:bg-white data-[state=active]:text-text-primary data-[state=active]:shadow-sm"
            >
              {t("skills.localFolder")}
            </TabsTrigger>
            <TabsTrigger
              value="github"
              className="rounded-full px-4 py-1.5 text-[13px] font-medium text-text-secondary transition-all data-[state=active]:bg-white data-[state=active]:text-text-primary data-[state=active]:shadow-sm"
            >
              {t("skills.githubLink")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="zip" className="mt-4">
            <DialogBody className="px-0">
              {done ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <CheckCircle2
                    size={32}
                    className="text-[var(--color-success)]"
                  />
                  <p className="text-[14px] font-medium text-text-primary">
                    {t("skills.importSuccess")}
                  </p>
                </div>
              ) : (
                <div>
                  <button
                    type="button"
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleDrop}
                    onClick={handleFileClick}
                    className={`w-full flex flex-col items-center justify-center gap-1.5 py-10 rounded-[12px] border border-dashed cursor-pointer transition-colors ${
                      dragOver
                        ? "border-[var(--color-brand-primary)] bg-[var(--color-brand-subtle)]"
                        : selectedFile
                          ? "border-[var(--color-success)] bg-[var(--color-success)]/5"
                          : "border-border-strong hover:border-text-muted hover:bg-surface-1"
                    }`}
                  >
                    {selectedFile ? (
                      <>
                        <p className="text-[13px] font-medium text-text-primary">
                          {selectedFile.name}
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {t("skills.clickToChange")}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-[13px] font-medium text-text-primary">
                          {t("skills.dropZipHere")}
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {t("skills.orClickBrowse")}
                        </p>
                      </>
                    )}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".zip"
                    className="hidden"
                    onChange={handleFileChange}
                  />
                  {importMutation.isError && (
                    <div className="flex items-start gap-1.5 mt-3">
                      <AlertCircle
                        size={12}
                        className="text-red-500 shrink-0 mt-0.5"
                      />
                      <p className="text-[11px] text-red-500 leading-relaxed">
                        {importMutation.error?.message ?? "Import failed"}
                      </p>
                    </div>
                  )}
                  <div className="flex items-start gap-1.5 mt-3">
                    <AlertCircle
                      size={12}
                      className="text-text-muted shrink-0 mt-0.5"
                    />
                    <p className="text-[11px] text-text-muted leading-relaxed">
                      {t("skills.zipHint")}
                    </p>
                  </div>
                </div>
              )}
            </DialogBody>
          </TabsContent>

          <TabsContent value="folder" className="mt-4">
            <DialogBody className="px-0">
              {done ? (
                <div className="flex flex-col items-center justify-center py-8 gap-2">
                  <CheckCircle2
                    size={32}
                    className="text-[var(--color-success)]"
                  />
                  <p className="text-[14px] font-medium text-text-primary">
                    {t("skills.importSuccess")}
                  </p>
                </div>
              ) : (
                <div>
                  <button
                    type="button"
                    onClick={() => void handleBrowseFolder()}
                    className={`w-full flex flex-col items-center justify-center gap-1.5 py-10 rounded-[12px] border border-dashed cursor-pointer transition-colors ${
                      folderPath
                        ? "border-[var(--color-success)] bg-[var(--color-success)]/5"
                        : "border-border-strong hover:border-text-muted hover:bg-surface-1"
                    }`}
                  >
                    <FolderOpen size={20} className="text-text-muted" />
                    {folderPath ? (
                      <>
                        <p className="text-[13px] font-medium text-text-primary break-all px-4 text-center">
                          {folderPath}
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {t("skills.clickToChange")}
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-[13px] font-medium text-text-primary">
                          {t("skills.browseFolder")}
                        </p>
                        <p className="text-[11px] text-text-muted">
                          {t("skills.noFolderSelected")}
                        </p>
                      </>
                    )}
                  </button>
                  {folderImportMutation.isError && (
                    <div className="flex items-start gap-1.5 mt-3">
                      <AlertCircle
                        size={12}
                        className="text-red-500 shrink-0 mt-0.5"
                      />
                      <p className="text-[11px] text-red-500 leading-relaxed">
                        {folderImportMutation.error?.message ?? "Import failed"}
                      </p>
                    </div>
                  )}
                  <div className="flex items-start gap-1.5 mt-3">
                    <AlertCircle
                      size={12}
                      className="text-text-muted shrink-0 mt-0.5"
                    />
                    <p className="text-[11px] text-text-muted leading-relaxed">
                      {t("skills.folderHint")}
                    </p>
                  </div>
                </div>
              )}
            </DialogBody>
          </TabsContent>

          <TabsContent value="github" className="mt-4">
            <DialogBody className="px-0">
              <div>
                <Label htmlFor="github-url" className="text-text-muted">
                  {t("skills.githubUrlLabel")}
                </Label>
                <Input
                  id="github-url"
                  type="url"
                  placeholder="https://github.com/user/repo"
                  className="mt-1.5"
                  disabled
                  readOnly
                />
                <div className="mt-4 flex items-start gap-1.5">
                  <Lock size={12} className="text-text-muted shrink-0 mt-0.5" />
                  <p className="text-[11px] text-text-muted leading-relaxed">
                    {t("skills.githubComingSoon")}
                  </p>
                </div>
              </div>
            </DialogBody>
          </TabsContent>
        </Tabs>

        {!done && (
          <DialogFooter>
            <Button variant="ghost" onClick={handleClose}>
              {t("skills.cancel")}
            </Button>
            <Button
              onClick={handleImport}
              disabled={
                tab === "github" ||
                (tab === "zip" &&
                  (!selectedFile || importMutation.isPending)) ||
                (tab === "folder" &&
                  (!folderPath || folderImportMutation.isPending))
              }
            >
              {importMutation.isPending || folderImportMutation.isPending
                ? t("skills.importing")
                : t("skills.import")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
