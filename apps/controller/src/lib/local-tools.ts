import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Local-tools — a minimal set of file-system / shell tools we expose to the
 * OpenAI-compatible model provider so the desktop chat can inspect and act
 * on files on the user's machine.
 *
 * These execute inside the controller sidecar process (regular Node.js, no
 * Electron sandbox), so they can read the entire user filesystem within the
 * OS-level permissions of the desktop app.
 *
 * Safety choices:
 * - All tools receive raw absolute paths from the model. We expand `~` and
 *   resolve to absolute paths on execution.
 * - `read_file` caps the returned content at MAX_FILE_BYTES to avoid pushing
 *   huge blobs back into the model context; larger files are truncated with
 *   a visible marker.
 * - `list_directory` caps entries at MAX_DIR_ENTRIES.
 * - `run_command` is intentionally NOT included in the default toolset —
 *   it's opt-in per call site because it can do arbitrary things.
 */

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 200 * 1024;
const MAX_DIR_ENTRIES = 200;
const MAX_COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;

/** JSON-schema tool definition sent to the OpenAI-compatible provider. */
export interface OpenAiToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/** Result of executing a local tool call. */
export interface LocalToolExecutionResult {
  /** Human-readable string that will be sent back to the model. */
  content: string;
  /** True if execution succeeded, false if it threw / rejected. */
  ok: boolean;
}

/**
 * Per-call options threaded through tool execution. Currently used to pin the
 * working directory of `run_command` (and to answer `get_workspace_directory`)
 * to a per-conversation workspace folder so each chat's generated files land in
 * their own directory instead of a shared one.
 */
export interface LocalToolOptions {
  /** Absolute path to this conversation's workspace directory, if any. */
  workspaceDir?: string;
  /**
   * When false, filesystem-mutating tools (write_file, create_directory) and
   * shell execution (run_command) are disabled — the "sandbox" is ON. Defaults
   * to allowed so the assistant can create files the user asks for.
   */
  allowFileWrites?: boolean;
}

const MAX_WRITE_FILE_BYTES = 5 * 1024 * 1024;

/** Expand a leading `~` to the user's home directory. */
function expandUser(p: string): string {
  if (!p) return p;
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homedir(), p.slice(2));
  }
  return p;
}

function resolveAbsPath(p: string): string {
  return path.resolve(expandUser(p));
}

function getDesktopPath(): string {
  return path.join(homedir(), "Desktop");
}

/**
 * The set of tools we advertise to the model. Kept minimal and read-only-ish
 * so a first-run user can meaningfully ask "check my desktop" without giving
 * the model arbitrary shell power.
 */
export const LOCAL_TOOL_DEFINITIONS: OpenAiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_home_directory",
      description:
        "Return the absolute path of the current user's home directory (e.g. C:\\Users\\alice on Windows, /Users/alice on macOS).",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_desktop_path",
      description:
        "Return the absolute path of the current user's Desktop folder.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_workspace_directory",
      description:
        "Return the absolute path of the current conversation's workspace folder. Files you create for this conversation (via run_command) should be written here so they are easy to find later. This is also the working directory that run_command runs in by default.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_platform_info",
      description:
        "Return the current operating system platform (win32, darwin, linux) and node version.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and folders inside a directory. Accepts absolute paths or `~/…` shortcuts. Returns names, whether each entry is a directory, size (bytes) and last-modified time. Capped at 200 entries.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute directory path. `~` and `~/subdir` are accepted.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a text file (UTF-8). Accepts absolute paths or `~/…` shortcuts. Content is truncated to 200 KB.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute file path. `~` and `~/subdir` accepted.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file with the given UTF-8 content. Accepts absolute paths or `~/…` shortcuts; a bare filename or relative path is written inside the current conversation's workspace directory. Parent directories are created automatically. This is the preferred way to create files for the user.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Target file path. Absolute, `~/…`, or a name/relative path (resolved inside the conversation workspace).",
          },
          content: {
            type: "string",
            description: "The full UTF-8 text content to write to the file.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a directory (and any missing parent directories). Accepts absolute paths, `~/…`, or a relative path inside the current conversation's workspace directory.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to create.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command and return its text output. On Windows the command runs via cmd /c, otherwise via /bin/sh -c, in the current conversation's workspace directory. Can be used to create, move, or modify files as well as inspect the system. Output is truncated to 32 KB and the command times out after 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command to run (e.g. `ls`, `dir`, `echo hello > note.txt`).",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

/** Names of tools that mutate the filesystem or execute shell commands. */
const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "create_directory",
  "run_command",
]);

/**
 * The subset of tools advertised to the model for a given call. When file
 * writes are disabled (sandbox ON), mutating/execution tools are withheld so
 * the model doesn't attempt actions that would be rejected.
 */
export function buildLocalToolDefinitions(
  allowFileWrites: boolean,
): OpenAiToolDefinition[] {
  if (allowFileWrites) {
    return LOCAL_TOOL_DEFINITIONS;
  }
  return LOCAL_TOOL_DEFINITIONS.filter(
    (def) => !WRITE_TOOL_NAMES.has(def.function.name),
  );
}

function truncateForModel(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  const head = buffer.subarray(0, maxBytes).toString("utf8");
  return `${head}\n\n… [truncated, original was ${buffer.length} bytes, showing first ${maxBytes}]`;
}

async function toolListDirectory(
  args: Record<string, unknown>,
): Promise<LocalToolExecutionResult> {
  const raw = typeof args.path === "string" ? args.path : "";
  if (!raw) {
    return { ok: false, content: "Missing `path` argument" };
  }
  const abs = resolveAbsPath(raw);
  try {
    const entries = await readdir(abs, { withFileTypes: true });
    const rows: string[] = [];
    let count = 0;
    for (const entry of entries) {
      if (count >= MAX_DIR_ENTRIES) {
        rows.push(
          `… [truncated, ${entries.length - MAX_DIR_ENTRIES} more entries]`,
        );
        break;
      }
      const full = path.join(abs, entry.name);
      let size = "-";
      let mtime = "-";
      try {
        const st = await stat(full);
        size = entry.isDirectory() ? "-" : String(st.size);
        mtime = st.mtime.toISOString();
      } catch {
        // stat may fail on permission-denied entries; keep going.
      }
      rows.push(
        `${entry.isDirectory() ? "d" : "f"}  ${entry.name.padEnd(40)}  ${size.padStart(10)}  ${mtime}`,
      );
      count += 1;
    }
    return {
      ok: true,
      content: `${abs}\n\n${rows.length === 0 ? "(empty directory)" : rows.join("\n")}`,
    };
  } catch (error) {
    return {
      ok: false,
      content: `Failed to list ${abs}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function toolReadFile(
  args: Record<string, unknown>,
): Promise<LocalToolExecutionResult> {
  const raw = typeof args.path === "string" ? args.path : "";
  if (!raw) {
    return { ok: false, content: "Missing `path` argument" };
  }
  const abs = resolveAbsPath(raw);
  try {
    const content = await readFile(abs, "utf8");
    return { ok: true, content: truncateForModel(content, MAX_FILE_BYTES) };
  } catch (error) {
    return {
      ok: false,
      content: `Failed to read ${abs}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function toolRunCommand(
  args: Record<string, unknown>,
  opts?: LocalToolOptions,
): Promise<LocalToolExecutionResult> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command.trim()) {
    return { ok: false, content: "Missing `command` argument" };
  }
  try {
    const isWindows = platform() === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellArgs = isWindows ? ["/c", command] : ["-c", command];
    const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
      timeout: MAX_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES * 2,
      windowsHide: true,
      // Run inside this conversation's workspace folder so files the command
      // creates land in a per-conversation directory instead of a shared one.
      ...(opts?.workspaceDir ? { cwd: opts.workspaceDir } : {}),
    });
    const combined = [stdout, stderr].filter(Boolean).join("\n").trim();
    return {
      ok: true,
      content:
        combined.length === 0
          ? "(command produced no output)"
          : truncateForModel(combined, MAX_COMMAND_OUTPUT_BYTES),
    };
  } catch (error) {
    return {
      ok: false,
      content: `Command failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Resolve a path argument for a write tool. Absolute and `~/…` paths are used
 * as-is; a bare filename or relative path is resolved inside the conversation
 * workspace directory (falling back to the process CWD when none is set).
 */
function resolveWritePath(raw: string, opts?: LocalToolOptions): string {
  const expanded = expandUser(raw);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  const base = opts?.workspaceDir ?? process.cwd();
  return path.resolve(base, expanded);
}

async function toolWriteFile(
  args: Record<string, unknown>,
  opts?: LocalToolOptions,
): Promise<LocalToolExecutionResult> {
  const raw = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!raw) {
    return { ok: false, content: "Missing `path` argument" };
  }
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_WRITE_FILE_BYTES) {
    return {
      ok: false,
      content: `Refusing to write ${byteLength} bytes (max ${MAX_WRITE_FILE_BYTES}).`,
    };
  }
  const abs = resolveWritePath(raw, opts);
  try {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return { ok: true, content: `Wrote ${byteLength} bytes to ${abs}` };
  } catch (error) {
    return {
      ok: false,
      content: `Failed to write ${abs}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function toolCreateDirectory(
  args: Record<string, unknown>,
  opts?: LocalToolOptions,
): Promise<LocalToolExecutionResult> {
  const raw = typeof args.path === "string" ? args.path : "";
  if (!raw) {
    return { ok: false, content: "Missing `path` argument" };
  }
  const abs = resolveWritePath(raw, opts);
  try {
    await mkdir(abs, { recursive: true });
    return { ok: true, content: `Created directory ${abs}` };
  } catch (error) {
    return {
      ok: false,
      content: `Failed to create directory ${abs}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Execute a tool call by name. */
export async function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
  opts?: LocalToolOptions,
): Promise<LocalToolExecutionResult> {
  // Guard: reject mutating/execution tools when file writes are disabled.
  // `allowFileWrites` defaults to allowed (undefined === allowed) so read-only
  // tools always work and callers that don't set it keep prior behaviour.
  if (WRITE_TOOL_NAMES.has(name) && opts?.allowFileWrites === false) {
    return {
      ok: false,
      content:
        "File writes and command execution are disabled (sandbox mode is ON). Ask the user to turn off sandbox mode in Settings to allow this.",
    };
  }
  switch (name) {
    case "get_home_directory":
      return { ok: true, content: homedir() };
    case "get_desktop_path":
      return { ok: true, content: getDesktopPath() };
    case "get_workspace_directory":
      return {
        ok: true,
        content:
          opts?.workspaceDir ??
          "No dedicated workspace directory is configured for this conversation; files will be created relative to the app's working directory.",
      };
    case "get_platform_info":
      return {
        ok: true,
        content: JSON.stringify({
          platform: platform(),
          arch: process.arch,
          node: process.versions.node,
          homedir: homedir(),
        }),
      };
    case "list_directory":
      return toolListDirectory(args);
    case "read_file":
      return toolReadFile(args);
    case "run_command":
      return toolRunCommand(args, opts);
    case "write_file":
      return toolWriteFile(args, opts);
    case "create_directory":
      return toolCreateDirectory(args, opts);
    default:
      return { ok: false, content: `Unknown tool: ${name}` };
  }
}

/** Short summary used for UI tool-call badges. */
export function summariseToolCall(
  name: string,
  args: Record<string, unknown>,
): string {
  switch (name) {
    case "list_directory":
      return typeof args.path === "string"
        ? `list_directory: ${args.path}`
        : "list_directory";
    case "read_file":
      return typeof args.path === "string"
        ? `read_file: ${args.path}`
        : "read_file";
    case "run_command":
      return typeof args.command === "string"
        ? `run_command: ${args.command.slice(0, 80)}`
        : "run_command";
    case "get_workspace_directory":
      return "get_workspace_directory";
    case "write_file":
      return typeof args.path === "string"
        ? `write_file: ${args.path}`
        : "write_file";
    case "create_directory":
      return typeof args.path === "string"
        ? `create_directory: ${args.path}`
        : "create_directory";
    default:
      return name;
  }
}
