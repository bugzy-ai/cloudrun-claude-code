import { RunRequest } from "./request.types.js";

/**
 * Request type for async Claude Code execution
 * Extends RunRequest with callback URL and optional task ID
 */
export interface AsyncRunRequest extends RunRequest {
  /**
   * Callback URL to POST results when task completes
   * Will receive AsyncTaskResult payload
   */
  callbackUrl: string;

  /**
   * Optional task ID - will be auto-generated if not provided
   * Must be unique and URL-safe
   */
  taskId?: string;

}

/**
 * Response returned immediately from /run-async endpoint
 */
export interface AsyncRunResponse {
  /** Unique identifier for the task */
  taskId: string;

  /** Initial status (always 'pending' on creation) */
  status: 'pending';

  /** GCS path where logs will be stored */
  logsPath: string;

  /** Timestamp when task was created */
  createdAt: string;

  /** Cloud Run Job execution name (optional, for tracking) */
  executionName?: string;
}

/**
 * Status of an async task
 */
export type AsyncTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Result posted to callback URL when task completes
 */
export interface AsyncTaskResult {
  /** Task identifier */
  taskId: string;

  /** Final status */
  status: 'completed' | 'failed' | 'cancelled';

  /** Exit code from Claude process */
  exitCode: number;

  /** GCS path to session logs */
  logsPath: string;

  /** Summary metrics */
  summary: {
    /** Task duration in milliseconds */
    durationMs: number;

    /** Number of conversation turns */
    turns?: number;

    /** Number of errors encountered */
    errors?: number;

    /** Start timestamp */
    startedAt: string;

    /** Completion timestamp */
    completedAt: string;

    /** Cancellation timestamp (if cancelled) */
    cancelledAt?: string;
  };

  /** Error message if task failed */
  error?: string;

  /** User-provided metadata from original request */
  metadata?: Record<string, any>;

  /** Uploaded files (if postExecutionActions.uploadFiles was requested) */
  uploadedFiles?: Array<{
    /** Original file path in workspace */
    originalPath: string;

    /** GCS path where file was uploaded */
    gcsPath: string;

    /** File size in bytes */
    sizeBytes: number;
  }>;

  /** External test repo PR information (if externalTestRepo was configured and changes were made) */
  externalRepoPR?: {
    /** PR URL on the external test repo */
    url: string;

    /** PR number */
    number: number;

    /** Full repo name (owner/repo) */
    repo: string;

    /** Branch that was pushed */
    branch: string;
  };

  /** Git commit information (if postExecutionActions.git was requested) */
  gitCommit?: {
    /** Commit SHA */
    sha: string;

    /** Commit message */
    message: string;

    /** Whether commit was pushed to remote */
    pushed: boolean;

    /** Branch that was pushed to */
    branch?: string;

    /** Recovery details (only present if push recovery was needed) */
    recovery?: {
      /** Recovery method used */
      method: "rebase" | "force-with-lease";

      /** Remote SHA that was on server before recovery */
      remoteSha: string;

      /** Files that had conflicts (if any) */
      conflictFiles?: string[];
    };
  };
}

/**
 * Metadata stored alongside task logs in GCS
 */
export interface AsyncTaskMetadata {
  taskId: string;
  status: AsyncTaskStatus;
  callbackUrl: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  error?: string;
  metadata?: Record<string, any>;
}
