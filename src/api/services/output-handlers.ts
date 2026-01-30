import { Request, Response } from "express";
import axios from "axios";
import { ClaudeRunResult } from "../../claude-runner.js";
import { GCSLoggerService, TaskLogger } from "./gcs.service.js";
import { GitService } from "./git.service.js";
import { AsyncTaskResult, AsyncTaskMetadata } from "../types/async-task.types.js";
import { logger } from "../../utils/logger.js";
import { readMcpErrorLog } from "../../utils/mcp-log-reader.js";

/**
 * OutputHandler interface
 * Defines how Claude Code output is handled (SSE stream, GCS logging, etc.)
 */
export interface OutputHandler {
  /**
   * Called for each line of JSONL output from Claude
   */
  onData(line: string): void;

  /**
   * Called when an error occurs during execution
   */
  onError(error: string): void;

  /**
   * Called when Claude execution completes
   */
  onComplete(result: ClaudeRunResult, durationMs: number): Promise<void>;

  /**
   * Called when task is cancelled
   */
  onCancel(durationMs: number): Promise<void>;

  /**
   * Cleanup resources
   */
  cleanup(): Promise<void>;
}

/**
 * SSEOutputHandler
 * Writes Claude output to Server-Sent Events (SSE) stream for synchronous requests
 */
export class SSEOutputHandler implements OutputHandler {
  private connectionClosed = false;

  constructor(
    private res: Response,
    private req?: Request
  ) {
    // Handle client disconnect
    if (this.req) {
      this.req.on("close", () => {
        logger.debug("Client disconnected, marking connection as closed");
        this.connectionClosed = true;
      });
    }
  }

  onData(line: string): void {
    if (this.connectionClosed) return;

    // Log Claude output at info level (visible without debug mode)
    if (line.trim()) {
      logger.info('[CLAUDE OUTPUT]', line);
    }

    try {
      // Try to parse as JSON
      const message = JSON.parse(line);
      this.res.write(`data: ${JSON.stringify(message)}\n\n`);
      (this.res as any).flush?.();
    } catch (e) {
      // If not JSON, send as text
      if (line.trim()) {
        this.res.write(`data: ${JSON.stringify({ type: "text", content: line })}\n\n`);
        (this.res as any).flush?.();
      }
    }
  }

  onError(error: string): void {
    if (this.connectionClosed) return;

    this.res.write(`event: error\ndata: ${JSON.stringify({ error })}\n\n`);
    (this.res as any).flush?.();
  }

  async onComplete(result: ClaudeRunResult, _durationMs: number): Promise<void> {
    if (this.connectionClosed) return;

    logger.debug(`Claude process completed with exit code: ${result.exitCode}`);

    if (result.exitCode !== 0) {
      this.res.write(`event: error\ndata: ${JSON.stringify({
        error: `Claude process exited with code ${result.exitCode}`,
        stderr: result.error
      })}\n\n`);
    }

    this.res.end();
  }

  async onCancel(_durationMs: number): Promise<void> {
    if (this.connectionClosed) return;

    logger.info('Task cancelled by user');

    this.res.write(`event: cancelled\ndata: ${JSON.stringify({
      message: 'Task cancelled by user'
    })}\n\n`);

    this.res.end();
  }

  async cleanup(): Promise<void> {
    // SSE handler doesn't need cleanup
  }

  isConnectionClosed(): boolean {
    return this.connectionClosed;
  }
}

/**
 * GCSOutputHandler
 * Writes Claude output to Google Cloud Storage and calls webhook on completion
 * Used for asynchronous background tasks
 */
export class GCSOutputHandler implements OutputHandler {
  private taskLogger: TaskLogger;
  private turnCount = 0;
  private errorCount = 0;
  private startedAt: string;
  private configFiles?: string[]; // Track dynamically created config files for git exclusion
  private initProcessed = false;
  private mcpServerStatuses: Array<{name: string, status: string}> = [];

  constructor(
    private taskId: string,
    private callbackUrl: string | undefined,
    private gcsLogger: GCSLoggerService,
    private metadata?: Record<string, any>,
    private workspaceRoot?: string,
    private sshKeyPath?: string,
    private postExecutionActions?: {
      git?: {
        commit: boolean;
        commitMessage?: string;
        push: boolean;
        branch?: string;
        files?: string[];
        conflictStrategy?: "auto" | "fail";
      };
      uploadFiles?: {
        globPatterns: string[];
        gcsPrefix?: string;
      };
    }
  ) {
    this.startedAt = new Date().toISOString();
    this.taskLogger = gcsLogger.createTaskLogger(taskId);
    logger.debug(`[TASK ${taskId}] GCS output handler initialized (mode: ${callbackUrl ? 'async' : 'sync'})`);

    // Save initial metadata (only for async tasks with callback URL)
    if (callbackUrl) {
      const initialMetadata: AsyncTaskMetadata = {
        taskId,
        status: 'running',
        callbackUrl,
        createdAt: this.startedAt,
        startedAt: this.startedAt,
        metadata: this.metadata
      };

      this.gcsLogger.saveMetadata(taskId, initialMetadata)
        .catch(error => {
          logger.error(`[TASK ${taskId}] Failed to save initial metadata:`, error.message);
        });
    }
  }

  /**
   * Set workspace details for post-execution actions
   * Called after workspace is created in TaskService
   */
  setWorkspaceDetails(workspaceRoot: string, sshKeyPath?: string, configFiles?: string[]): void {
    this.workspaceRoot = workspaceRoot;
    this.sshKeyPath = sshKeyPath;
    this.configFiles = configFiles;
    if (configFiles && configFiles.length > 0) {
      logger.debug(`[TASK ${this.taskId}] Workspace details set for post-execution actions (${configFiles.length} config files to exclude from commits)`);
    } else {
      logger.debug(`[TASK ${this.taskId}] Workspace details set for post-execution actions`);
    }
  }

  onData(line: string): void {
    if (line.trim()) {
      logger.info(`[TASK ${this.taskId}] [CLAUDE OUTPUT]`, line);

      // Write to GCS
      this.taskLogger.write(line);

      // Track metrics from JSONL output
      try {
        const message = JSON.parse(line);

        // Check for system init message (MCP server statuses)
        if (!this.initProcessed && message.type === 'system' && message.subtype === 'init') {
          this.initProcessed = true;
          this.processInitMessage(message);
        }

        if (message.type === 'turn_complete') {
          this.turnCount++;
        } else if (message.type === 'error') {
          this.errorCount++;
        }
      } catch (e) {
        // Not JSON or parsing failed - that's ok
      }
    }
  }

  onError(error: string): void {
    logger.error(`[TASK ${this.taskId}] Claude error:`, error);
    this.taskLogger.write(JSON.stringify({
      type: 'error',
      error,
      timestamp: new Date().toISOString()
    }));
    this.errorCount++;
  }

  async onComplete(result: ClaudeRunResult, durationMs: number): Promise<void> {
    logger.info(`[TASK ${this.taskId}] Claude process completed with exit code: ${result.exitCode}`);

    const completedAt = new Date().toISOString();

    // Save final metadata (only for async tasks with callback URL)
    if (this.callbackUrl) {
      const finalMetadata: AsyncTaskMetadata = {
        taskId: this.taskId,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        callbackUrl: this.callbackUrl,
        createdAt: this.startedAt,
        startedAt: this.startedAt,
        completedAt,
        error: result.error,
        metadata: this.metadata
      };

      try {
        await this.gcsLogger.saveMetadata(this.taskId, finalMetadata);
      } catch (error: any) {
        logger.error(`[TASK ${this.taskId}] Failed to save final metadata:`, error.message);
      }
    }

    // Execute post-execution actions (if requested and task succeeded)
    let uploadedFiles: Array<{ originalPath: string; gcsPath: string; sizeBytes: number }> | undefined;
    let gitCommit: {
      sha: string;
      message: string;
      pushed: boolean;
      branch?: string;
      recovery?: {
        method: "rebase" | "force-with-lease";
        remoteSha: string;
        conflictFiles?: string[];
      };
    } | undefined;

    if (result.exitCode === 0 && this.postExecutionActions && this.workspaceRoot) {
      // Upload files if requested
      if (this.postExecutionActions.uploadFiles) {
        try {
          logger.info(`[TASK ${this.taskId}] Uploading files matching patterns: ${this.postExecutionActions.uploadFiles.globPatterns.join(', ')}`);
          uploadedFiles = await this.gcsLogger.uploadFilesByGlob(
            this.taskId,
            this.workspaceRoot,
            this.postExecutionActions.uploadFiles.globPatterns,
            this.postExecutionActions.uploadFiles.gcsPrefix
          );
          logger.info(`[TASK ${this.taskId}] Uploaded ${uploadedFiles.length} files to GCS`);
        } catch (uploadError: any) {
          logger.error(`[TASK ${this.taskId}] Failed to upload files:`, uploadError.message);
          // Continue - don't fail task if upload fails
        }
      }

      // Git operations if requested
      if (this.postExecutionActions.git && (this.postExecutionActions.git.commit || this.postExecutionActions.git.push)) {
        try {
          const gitService = new GitService();

          logger.info(`[TASK ${this.taskId}] Checking for git changes in workspace: ${this.workspaceRoot}`);

          // Check if there are changes to commit
          const hasChanges = await gitService.hasChanges(this.workspaceRoot);

          if (hasChanges && this.postExecutionActions.git.commit) {
            logger.info(`[TASK ${this.taskId}] Git changes detected - preparing to commit`);

            const commitMessage = this.postExecutionActions.git.commitMessage ||
              `Task execution ${this.taskId}\n\n🤖 Generated by Bugzy AI`;

            logger.debug(`[TASK ${this.taskId}] Commit message: ${commitMessage.split('\n')[0]}...`);

            // Determine which files to commit
            let filesToCommit = this.postExecutionActions.git.files;

            // If no explicit files list and we have config files to exclude
            if (!filesToCommit && this.configFiles && this.configFiles.length > 0) {
              // Get all changed files and exclude config files
              const allChangedFiles = await gitService.getChangedFiles(this.workspaceRoot);
              filesToCommit = allChangedFiles.filter(file => !this.configFiles!.includes(file));

              if (filesToCommit.length === 0) {
                logger.info(`[TASK ${this.taskId}] All changes are in config files - skipping commit`);
                filesToCommit = undefined; // Reset to skip commit
              } else {
                logger.info(`[TASK ${this.taskId}] Excluding ${this.configFiles.length} config files from commit (committing ${filesToCommit.length} files)`);
                logger.debug(`[TASK ${this.taskId}] Excluded files: ${this.configFiles.join(', ')}`);
              }
            }

            // Only commit if we have files to commit
            if (filesToCommit !== undefined || !this.configFiles || this.configFiles.length === 0) {
              const commitResult = await gitService.commit(
                this.workspaceRoot,
                commitMessage,
                filesToCommit,
                this.sshKeyPath
              );

              logger.info(`[TASK ${this.taskId}] ✓ Commit created: ${commitResult.sha.substring(0, 7)}`);

              gitCommit = {
                sha: commitResult.sha,
                message: commitResult.message,
                pushed: false
              };

              // Push if requested
              if (this.postExecutionActions.git.push) {
                const branch = this.postExecutionActions.git.branch || 'main';
                const conflictStrategy = this.postExecutionActions.git.conflictStrategy || 'auto';

                logger.info(`[TASK ${this.taskId}] Pushing commit to remote branch: ${branch} (conflictStrategy: ${conflictStrategy})`);

                const pushResult = await gitService.push(
                  this.workspaceRoot,
                  branch,
                  this.sshKeyPath,
                  conflictStrategy
                );

                gitCommit.pushed = pushResult.success;
                gitCommit.branch = branch;

                // Add recovery information if present
                if (pushResult.recovery) {
                  gitCommit.recovery = pushResult.recovery;
                  logger.info(`[TASK ${this.taskId}] ✓ Push completed with ${pushResult.recovery.method} recovery`);
                  if (pushResult.recovery.conflictFiles && pushResult.recovery.conflictFiles.length > 0) {
                    logger.info(`[TASK ${this.taskId}] Conflict files: ${pushResult.recovery.conflictFiles.join(', ')}`);
                  }
                } else {
                  logger.info(`[TASK ${this.taskId}] ✓ Successfully pushed changes to ${branch}`);
                }
              }
            }
          } else if (!hasChanges) {
            logger.info(`[TASK ${this.taskId}] No git changes detected - skipping commit`);
          }
        } catch (gitError: any) {
          logger.error(`[TASK ${this.taskId}] Failed to perform git operations:`, gitError.message);
          logger.error(`[TASK ${this.taskId}] Git error details:`, gitError.stack || gitError);
          // Continue - don't fail task if git operations fail
        }
      }
    }

    // Call webhook (only for async tasks with callback URL)
    if (this.callbackUrl) {
      // Prepare callback payload
      const callbackPayload: AsyncTaskResult = {
        taskId: this.taskId,
        status: result.exitCode === 0 ? 'completed' : 'failed',
        exitCode: result.exitCode,
        logsPath: this.gcsLogger.getLogsPath(this.taskId),
        summary: {
          durationMs,
          turns: this.turnCount > 0 ? this.turnCount : undefined,
          errors: this.errorCount > 0 ? this.errorCount : undefined,
          startedAt: this.startedAt,
          completedAt
        },
        error: result.error,
        metadata: this.metadata,
        uploadedFiles,
        gitCommit
      };

      // Call webhook
      await this.callWebhook(callbackPayload);
    }

    logger.info(`[TASK ${this.taskId}] Task completed successfully in ${durationMs}ms`);
  }

  async onCancel(durationMs: number): Promise<void> {
    logger.info(`[TASK ${this.taskId}] Task cancelled by user`);

    const cancelledAt = new Date().toISOString();

    // Save cancellation metadata (only for async tasks with callback URL)
    if (this.callbackUrl) {
      const cancelMetadata: AsyncTaskMetadata = {
        taskId: this.taskId,
        status: 'cancelled',
        callbackUrl: this.callbackUrl,
        createdAt: this.startedAt,
        startedAt: this.startedAt,
        completedAt: cancelledAt,
        cancelledAt,
        error: 'Task cancelled by user',
        metadata: this.metadata
      };

      try {
        await this.gcsLogger.saveMetadata(this.taskId, cancelMetadata);
      } catch (error: any) {
        logger.error(`[TASK ${this.taskId}] Failed to save cancellation metadata:`, error.message);
      }

      // Prepare callback payload
      const callbackPayload: AsyncTaskResult = {
        taskId: this.taskId,
        status: 'cancelled',
        exitCode: 130, // Standard exit code for SIGTERM (cancelled)
        logsPath: this.gcsLogger.getLogsPath(this.taskId),
        summary: {
          durationMs,
          turns: this.turnCount > 0 ? this.turnCount : undefined,
          errors: this.errorCount > 0 ? this.errorCount : undefined,
          startedAt: this.startedAt,
          completedAt: cancelledAt,
          cancelledAt
        },
        error: 'Task cancelled by user',
        metadata: this.metadata
      };

      // Call webhook
      await this.callWebhook(callbackPayload);
    }

    logger.info(`[TASK ${this.taskId}] Task cancellation handled in ${durationMs}ms`);
  }

  async cleanup(): Promise<void> {
    // Close logger stream
    try {
      this.taskLogger.end();
      await new Promise((resolve, reject) => {
        this.taskLogger.on('finish', resolve);
        this.taskLogger.on('error', reject);
        setTimeout(() => reject(new Error('Timeout waiting for logger to finish')), 5000);
      });
      logger.debug(`[TASK ${this.taskId}] GCS logger closed`);
    } catch (error: any) {
      logger.error(`[TASK ${this.taskId}] Failed to close GCS logger:`, error.message);
    }
  }

  /**
   * Process the system init message to detect MCP server health
   */
  private processInitMessage(message: any): void {
    const mcpServers: Array<{name: string, status: string}> | undefined = message.mcp_servers;

    if (!mcpServers || mcpServers.length === 0) {
      logger.info(`[TASK ${this.taskId}] No MCP servers configured`);
      return;
    }

    this.mcpServerStatuses = mcpServers;

    const connected = mcpServers.filter(s => s.status === 'connected');
    const failed = mcpServers.filter(s => s.status !== 'connected');

    // Build summary string: "slack: connected, jira: failed, ..."
    const statusDetails = mcpServers.map(s => `${s.name}: ${s.status}`).join(', ');
    const summary = `[TASK ${this.taskId}] MCP servers: ${connected.length}/${mcpServers.length} connected (${statusDetails})`;

    if (failed.length === mcpServers.length) {
      // ALL servers failed
      logger.error(summary);
    } else if (failed.length > 0) {
      // Some servers failed
      logger.warn(summary);
    } else {
      // All connected
      logger.info(summary);
    }

    // Log each failed server individually
    for (const server of failed) {
      logger.warn(`[TASK ${this.taskId}] MCP server '${server.name}' failed to connect (status: ${server.status})`);
      // Fire-and-forget: read detailed error logs from filesystem
      readMcpErrorLog(server.name, this.workspaceRoot).then(result => {
        if (!result.found) {
          logger.warn(`[TASK ${this.taskId}] ${result.reason}`);
          return;
        }
        if (result.entries) {
          for (const entry of result.entries) {
            if (entry.error) {
              logger.error(`[TASK ${this.taskId}] MCP [${server.name}] ${entry.error}`);
            }
            if (entry.debug && typeof entry.debug === 'string' && entry.debug.includes('Connection failed')) {
              logger.error(`[TASK ${this.taskId}] MCP [${server.name}] ${entry.debug}`);
            }
          }
        } else if (result.rawContent) {
          logger.warn(`[TASK ${this.taskId}] Could not parse MCP log file for '${server.name}' as JSON, raw content:`);
          logger.warn(`[TASK ${this.taskId}] MCP [${server.name}] ${result.rawContent}`);
        }
      }).catch(err => {
        logger.warn(`[TASK ${this.taskId}] Failed to read MCP error log for '${server.name}': ${err.message}`);
      });
    }
  }

  private async callWebhook(payload: AsyncTaskResult): Promise<void> {
    // This method should only be called when callbackUrl is defined
    if (!this.callbackUrl) {
      logger.warn(`[TASK ${this.taskId}] callWebhook called but no callbackUrl defined`);
      return;
    }

    logger.info(`[TASK ${this.taskId}] Calling webhook: ${this.callbackUrl}`);

    try {
      const secret = process.env.CLOUDRUN_CALLBACK_SECRET;

      if (!secret) {
        logger.error(`[TASK ${this.taskId}] CLOUDRUN_CALLBACK_SECRET not set - cannot sign webhook`);
        throw new Error('CLOUDRUN_CALLBACK_SECRET is required for webhook authentication');
      }

      // Current timestamp (seconds since epoch)
      const timestamp = Math.floor(Date.now() / 1000).toString();

      // Serialize payload (consistent JSON stringification)
      const payloadString = JSON.stringify(payload);

      // Create signature: HMAC-SHA256(secret, timestamp + "." + payload)
      const crypto = await import('crypto');
      const signature = crypto
        .createHmac('sha256', secret)
        .update(`${timestamp}.${payloadString}`)
        .digest('hex');

      logger.debug(`[TASK ${this.taskId}] Generated webhook signature`);

      const response = await axios.post(this.callbackUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': `sha256=${signature}`,
          'X-Webhook-Timestamp': timestamp,
          'User-Agent': 'cloudrun-claude-code/async-task'
        },
        timeout: 30000, // 30 second timeout
        validateStatus: () => true // Don't throw on any status code
      });

      if (response.status >= 200 && response.status < 300) {
        logger.info(`[TASK ${this.taskId}] Webhook called successfully (status: ${response.status})`);
      } else {
        logger.warn(`[TASK ${this.taskId}] Webhook returned non-2xx status: ${response.status}`, response.data);
      }
    } catch (error: any) {
      logger.error(`[TASK ${this.taskId}] Failed to call webhook:`, error.message);
      // Don't throw - we've already completed the task, webhook failure shouldn't crash the service
    }
  }
}
