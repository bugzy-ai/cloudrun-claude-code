import { describe, it, expect, vi, beforeEach } from "vitest";
import { readMcpErrorLog } from "../../src/utils/mcp-log-reader.js";

// Mock modules
vi.mock("fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(),
}));

vi.mock("os", () => ({
  default: {
    homedir: () => "/home/testuser",
    platform: () => "linux",
  },
}));

import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import os from "os";

const mockedReaddir = vi.mocked(readdir);
const mockedReadFile = vi.mocked(readFile);
const mockedExistsSync = vi.mocked(existsSync);

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.HOME;
});

describe("readMcpErrorLog", () => {
  it("happy path — reads and parses JSON log entries", async () => {
    process.env.HOME = "/home/testuser";
    const entries = [
      { error: "Failed to connect to MCP server" },
      { debug: "Connection failed: ECONNREFUSED" },
    ];

    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return true;
      if (s.includes("mcp-logs-slack")) return true;
      return false;
    });
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude"] as any;
      if (s.includes("mcp-logs-slack")) return ["2025-01-01T00-00-00.txt"] as any;
      return [] as any;
    });
    mockedReadFile.mockResolvedValue(JSON.stringify(entries));

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(true);
    expect(result.entries).toEqual(entries);
    expect(result.logFile).toContain("2025-01-01T00-00-00.txt");
  });

  it("returns not found when cache directory is missing", async () => {
    process.env.HOME = "/home/testuser";
    mockedExistsSync.mockReturnValue(false);

    const result = await readMcpErrorLog("slack");

    expect(result.found).toBe(false);
    expect(result.reason).toContain("Cache directory not found");
  });

  it("returns not found when no claude* directories exist", async () => {
    process.env.HOME = "/home/testuser";
    mockedExistsSync.mockImplementation((p) => {
      return String(p) === "/home/testuser/.cache";
    });
    mockedReaddir.mockResolvedValue(["some-other-dir", "not-claude"] as any);

    const result = await readMcpErrorLog("slack");

    expect(result.found).toBe(false);
    expect(result.reason).toContain("Could not find MCP cache directory");
  });

  it("returns not found when no mcp-logs directory exists", async () => {
    process.env.HOME = "/home/testuser";
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return true;
      // mcp-logs-slack does not exist
      return false;
    });
    mockedReaddir.mockResolvedValue(["claude"] as any);

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(false);
    expect(result.reason).toContain("No MCP log directory found for server: slack");
  });

  it("returns not found when no .txt files in log dir", async () => {
    process.env.HOME = "/home/testuser";
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude"] as any;
      if (s.includes("mcp-logs-slack")) return ["readme.md", "notes.json"] as any;
      return [] as any;
    });

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(false);
    expect(result.reason).toContain("No MCP log files found for server: slack");
  });

  it("returns rawContent when JSON parsing fails", async () => {
    process.env.HOME = "/home/testuser";
    const rawContent = "this is not json {{{";

    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude"] as any;
      if (s.includes("mcp-logs-slack")) return ["log.txt"] as any;
      return [] as any;
    });
    mockedReadFile.mockResolvedValue(rawContent);

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(true);
    expect(result.rawContent).toBe(rawContent);
    expect(result.entries).toBeUndefined();
  });

  it("returns not found when log file is not a JSON array", async () => {
    process.env.HOME = "/home/testuser";
    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude"] as any;
      if (s.includes("mcp-logs-jira")) return ["log.txt"] as any;
      return [] as any;
    });
    mockedReadFile.mockResolvedValue(JSON.stringify({ not: "an array" }));

    const result = await readMcpErrorLog("jira", "/workspace");

    expect(result.found).toBe(false);
    expect(result.reason).toContain("not a JSON array");
  });

  it("skips claude dirs without logs and finds the correct one", async () => {
    process.env.HOME = "/home/testuser";
    const entries = [{ error: "timeout" }];

    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return true;
      // Only second claude dir has the mcp-logs directory
      if (s.includes("claude-v2") && s.includes("mcp-logs-slack")) return true;
      return false;
    });
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude-v1", "claude-v2"] as any;
      if (s.includes("mcp-logs-slack")) return ["log.txt"] as any;
      return [] as any;
    });
    mockedReadFile.mockResolvedValue(JSON.stringify(entries));

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(true);
    expect(result.entries).toEqual(entries);
    expect(result.logFile).toContain("claude-v2");
  });

  it("picks most recent log file by reverse sort", async () => {
    process.env.HOME = "/home/testuser";
    const entries = [{ error: "latest error" }];

    mockedExistsSync.mockReturnValue(true);
    mockedReaddir.mockImplementation(async (p) => {
      const s = String(p);
      if (s === "/home/testuser/.cache") return ["claude"] as any;
      if (s.includes("mcp-logs-slack"))
        return [
          "2025-01-01T00-00-00.txt",
          "2025-06-15T12-30-00.txt",
          "2025-03-10T08-00-00.txt",
        ] as any;
      return [] as any;
    });
    mockedReadFile.mockResolvedValue(JSON.stringify(entries));

    const result = await readMcpErrorLog("slack", "/workspace");

    expect(result.found).toBe(true);
    // readFile should have been called with the most recent (reverse-sorted) file
    expect(mockedReadFile).toHaveBeenCalledWith(
      expect.stringContaining("2025-06-15T12-30-00.txt"),
      "utf-8"
    );
  });

  it("uses macOS cache path on darwin platform", async () => {
    process.env.HOME = "/Users/testuser";
    // Override platform to darwin
    vi.spyOn(os, "platform").mockReturnValue("darwin");

    mockedExistsSync.mockImplementation((p) => {
      return String(p) === "/Users/testuser/Library/Caches";
    });
    mockedReaddir.mockResolvedValue(["not-a-claude-dir"] as any);

    const result = await readMcpErrorLog("slack");

    expect(result.found).toBe(false);
    // Verify it checked the macOS path (no claude dirs found, but it did look in the right place)
    expect(mockedExistsSync).toHaveBeenCalledWith(
      "/Users/testuser/Library/Caches"
    );
    expect(mockedReaddir).toHaveBeenCalledWith(
      "/Users/testuser/Library/Caches"
    );
  });

  it("uses Linux cache path on linux platform", async () => {
    process.env.HOME = "/home/testuser";
    vi.spyOn(os, "platform").mockReturnValue("linux");

    mockedExistsSync.mockImplementation((p) => {
      return String(p) === "/home/testuser/.cache";
    });
    mockedReaddir.mockResolvedValue([] as any);

    const result = await readMcpErrorLog("slack");

    expect(result.found).toBe(false);
    expect(mockedExistsSync).toHaveBeenCalledWith("/home/testuser/.cache");
    expect(mockedReaddir).toHaveBeenCalledWith("/home/testuser/.cache");
  });
});
