import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import os from "os";
import path from "path";

export interface McpLogEntry {
  error?: string;
  debug?: string;
}

export interface McpLogReadResult {
  found: boolean;
  entries?: McpLogEntry[];
  logFile?: string;
  reason?: string;
  rawContent?: string;
}

/**
 * Read detailed MCP error logs from the Claude CLI cache directory.
 *
 * Returns a structured result instead of logging directly, so the caller
 * can decide how to handle the output.
 */
export async function readMcpErrorLog(
  serverName: string,
  workspaceRoot?: string
): Promise<McpLogReadResult> {
  const home = process.env.HOME || os.homedir();

  // Determine cache base: Linux/Docker uses ~/.cache, macOS uses ~/Library/Caches
  const platform = os.platform();
  const cacheBase =
    platform === "darwin"
      ? path.join(home, "Library", "Caches")
      : path.join(home, ".cache");

  if (!existsSync(cacheBase)) {
    return {
      found: false,
      reason: `Cache directory not found: ${cacheBase}`,
    };
  }

  // Scan for claude* directories (handles claude-cli-nodejs, claude, etc.)
  let cacheDirEntries: string[];
  try {
    cacheDirEntries = await readdir(cacheBase);
  } catch (err: any) {
    return {
      found: false,
      reason: `Could not read cache directory: ${err.message}`,
    };
  }

  const claudeDirs = cacheDirEntries.filter((name) =>
    name.startsWith("claude")
  );
  if (claudeDirs.length === 0) {
    return {
      found: false,
      reason: "Could not find MCP cache directory for error logs",
    };
  }

  // Build sanitized workspace path: /workspace → -workspace
  const workspacePath = workspaceRoot || "/workspace";
  const sanitizedWorkspace = workspacePath.replace(/\//g, "-");

  // Try each claude* directory to find the MCP logs
  for (const claudeDir of claudeDirs) {
    const mcpLogDir = path.join(
      cacheBase,
      claudeDir,
      sanitizedWorkspace,
      `mcp-logs-${serverName}`
    );

    if (!existsSync(mcpLogDir)) {
      continue;
    }

    // Find log files
    let logFiles: string[];
    try {
      logFiles = (await readdir(mcpLogDir)).filter((f) => f.endsWith(".txt"));
    } catch (err: any) {
      return {
        found: false,
        reason: `Could not read MCP log directory for '${serverName}': ${err.message}`,
      };
    }

    if (logFiles.length === 0) {
      return {
        found: false,
        reason: `No MCP log files found for server: ${serverName}`,
      };
    }

    // Sort descending to get most recent file first (ISO timestamp filenames)
    logFiles.sort().reverse();
    const latestLogFile = path.join(mcpLogDir, logFiles[0]);

    // Read and parse the log file
    let rawContent: string;
    try {
      rawContent = await readFile(latestLogFile, "utf-8");
    } catch (err: any) {
      return {
        found: false,
        reason: `Could not read MCP log file for '${serverName}': ${err.message}`,
      };
    }

    try {
      const entries = JSON.parse(rawContent);
      if (!Array.isArray(entries)) {
        return {
          found: false,
          reason: `MCP log file for '${serverName}' is not a JSON array`,
          logFile: latestLogFile,
        };
      }

      return {
        found: true,
        entries: entries as McpLogEntry[],
        logFile: latestLogFile,
      };
    } catch {
      // JSON parse failed — return raw content as fallback
      return {
        found: true,
        rawContent: rawContent.substring(0, 2000),
        logFile: latestLogFile,
      };
    }
  }

  // None of the claude* directories had logs for this server
  return {
    found: false,
    reason: `No MCP log directory found for server: ${serverName}`,
  };
}
