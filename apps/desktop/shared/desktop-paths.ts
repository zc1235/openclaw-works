import { homedir } from "node:os";
import { resolve } from "node:path";

export function getDesktopNexuHomeDir(_userDataPath: string): string {
  return resolve(homedir(), ".lingguang");
}

/**
 * Previous per-user home directory (before the .nexu -> .lingguang rename).
 * Used only to migrate existing config/data into the new location.
 */
export function getLegacyHomeNexuDir(): string {
  return resolve(homedir(), ".nexu");
}

export function getOpenclawSkillsDir(userDataPath: string): string {
  return resolve(userDataPath, "runtime/openclaw/state/skills");
}

export function getSkillhubCacheDir(userDataPath: string): string {
  return resolve(userDataPath, "runtime/skillhub-cache");
}
