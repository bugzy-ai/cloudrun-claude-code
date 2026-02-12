import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "events";
import { mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";

// Mock child_process.spawn to return controllable fake processes
const mockSpawn = vi.fn();
vi.mock("child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("child_process")>();
  return {
    ...original,
    spawn: (...args: any[]) => mockSpawn(...args),
  };
});

// Must import AFTER vi.mock
const { ClaudeRunner } = await import("../src/claude-runner.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "claude-runner-test-"));
  mockSpawn.mockReset();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/**
 * Create a mock ChildProcess that emits events and has controllable stdio.
 */
function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  proc.pid = 12345;
  proc.killed = false;
  proc.kill = vi.fn((signal?: string) => {
    proc.killed = true;
  });
  return proc;
}

/** Emit a line of stdout from a mock process */
function emitLine(proc: any, line: string) {
  proc.stdout.emit("data", Buffer.from(line + "\n"));
}

describe("ClaudeRunner post-result shutdown", () => {
  it("force-kills process that hangs after emitting result", async () => {
    const gracePeriodMs = 500;
    const mockProc = createMockProcess();

    mockSpawn.mockReturnValue(mockProc);

    const runner = new ClaudeRunner(tmpDir, { shutdownGracePeriodMs: gracePeriodMs });
    const lines: string[] = [];

    const resultPromise = runner.runDirect(
      "test prompt",
      { timeoutMinutes: 1 },
      (line) => lines.push(line),
      () => {},
    );

    // Wait for runDirect to finish setup (it has awaits in buildArgs)
    await new Promise((r) => setTimeout(r, 50));

    // Emit some output then the result event
    emitLine(mockProc, JSON.stringify({ type: "assistant", message: "hello" }));
    emitLine(mockProc, JSON.stringify({ type: "result", subtype: "success", result: "done" }));

    // Process hangs — don't emit 'close'

    // Wait for the grace period to fire
    const startTime = Date.now();
    await vi.waitFor(() => {
      expect(mockProc.kill).toHaveBeenCalled();
    }, { timeout: gracePeriodMs + 2000 });
    const killElapsed = Date.now() - startTime;

    // Kill should have been called roughly after the grace period
    expect(killElapsed).toBeGreaterThanOrEqual(gracePeriodMs - 100);
    expect(killElapsed).toBeLessThan(gracePeriodMs + 1000);

    // Now simulate the process actually closing after being killed
    mockProc.emit("close", null, "SIGTERM");

    const result = await resultPromise;

    // Verify result and lines
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"type":"result"');
    expect(result.exitCode).toBe(0); // null || 0 = 0
  }, 10000);

  it("does not kill process that exits cleanly after result", async () => {
    const gracePeriodMs = 1000;
    const mockProc = createMockProcess();

    mockSpawn.mockReturnValue(mockProc);

    const runner = new ClaudeRunner(tmpDir, { shutdownGracePeriodMs: gracePeriodMs });
    const lines: string[] = [];

    const resultPromise = runner.runDirect(
      "test prompt",
      { timeoutMinutes: 1 },
      (line) => lines.push(line),
      () => {},
    );

    // Wait for runDirect to finish setup (it has awaits in buildArgs)
    await new Promise((r) => setTimeout(r, 50));

    // Emit result, then close promptly
    emitLine(mockProc, JSON.stringify({ type: "result", subtype: "success", result: "done" }));

    // Process exits cleanly 50ms after result
    await new Promise((r) => setTimeout(r, 50));
    mockProc.emit("close", 0);

    const result = await resultPromise;

    expect(result.exitCode).toBe(0);
    expect(mockProc.kill).not.toHaveBeenCalled();

    // Wait a bit past the grace period to ensure the timer was cleared
    await new Promise((r) => setTimeout(r, gracePeriodMs + 200));
    expect(mockProc.kill).not.toHaveBeenCalled();
  }, 10000);

  it("main timeout still works when no result event is emitted", async () => {
    const mockProc = createMockProcess();

    mockSpawn.mockReturnValue(mockProc);

    // Very short main timeout for testing
    const runner = new ClaudeRunner(tmpDir, { shutdownGracePeriodMs: 60000 });
    const lines: string[] = [];

    const resultPromise = runner.runDirect(
      "test prompt",
      { timeoutMinutes: 0.01 }, // ~600ms
      (line) => lines.push(line),
      () => {},
    );

    // Wait for runDirect to finish setup (it has awaits in buildArgs)
    await new Promise((r) => setTimeout(r, 50));

    // Emit non-result output, process hangs
    emitLine(mockProc, JSON.stringify({ type: "assistant", message: "working..." }));

    // Don't emit result or close — main timeout should fire

    // Simulate the close after kill
    mockProc.kill.mockImplementation(() => {
      mockProc.killed = true;
      setTimeout(() => mockProc.emit("close", null, "SIGTERM"), 50);
    });

    const result = await resultPromise;

    expect(result.exitCode).toBe(124); // timeout exit code
    expect(result.error).toBe("Process timed out");
    expect(mockProc.kill).toHaveBeenCalled();
  }, 10000);
});
