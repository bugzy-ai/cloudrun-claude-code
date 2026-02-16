import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { ClaudeRunner, ClaudeOptions } from "../../claude-runner.js";
import { GitService } from "./git.service.js";
import { WorkspaceService } from "./workspace.service.js";
import { ClaudeConfigService } from "./claude-config.service.js";
import { SimpleAnthropicProxy } from "./simple-proxy.js";
import { OutputHandler } from "./output-handlers.js";
import { RunRequest } from "../types/request.types.js";
import { createModuleLogger } from "../../utils/logger.js";

const logger = createModuleLogger('task');

/**
 * TaskService
 * Service for executing Claude Code tasks in Cloud Run Jobs
 * Used only by job-worker.ts (not by the main service)
 * Uses OutputHandler strategy pattern to handle different output modes
 */
export class TaskService {
  private gitService: GitService;
  private workspaceService: WorkspaceService;
  private claudeConfigService: ClaudeConfigService;

  constructor() {
    this.gitService = new GitService();
    this.workspaceService = new WorkspaceService();
    this.claudeConfigService = new ClaudeConfigService();
  }

  /**
   * Execute a Claude Code task with the given output handler
   * This method orchestrates the full execution flow and works for both sync and async modes
   */
  async executeTask(
    request: RunRequest,
    outputHandler: OutputHandler,
    taskId?: string
  ): Promise<void> {
    const startTime = Date.now();

    // Generate task ID for sync requests (async requests already have one)
    const effectiveTaskId = taskId || `sync-${crypto.randomUUID()}`;
    const taskType = taskId ? 'async' : 'sync';
    const logPrefix = `[TASK ${effectiveTaskId}]`;

    logger.info(`${logPrefix} Starting task execution (type: ${taskType})`);

    let workspaceRoot: string | undefined;
    let proxy: SimpleAnthropicProxy | undefined;
    let runner: ClaudeRunner | undefined;
    let cleanedUp = false;

    try {
      // Setup proxy
      const { proxy: proxyInstance, proxyPort } = await this.setupProxy(
        request.anthropicApiKey,
        request.anthropicOAuthToken,
        logPrefix
      );
      proxy = proxyInstance;

      // Setup workspace (create, SSH keys, git clone, config files)
      const { workspaceRoot: workspace, sshKeyPath, configFiles } = await this.setupWorkspace(
        request,
        logPrefix
      );
      workspaceRoot = workspace;

      // Create subdirectory if needed
      await this.workspaceService.createSubdirectory(workspaceRoot, request.cwdRelative || '.');

      // Set workspace details on output handler (for post-execution actions)
      if (outputHandler && 'setWorkspaceDetails' in outputHandler) {
        (outputHandler as any).setWorkspaceDetails(workspaceRoot, sshKeyPath, configFiles, request.externalTestRepo);
      }

      // Setup environment (secrets, proxy config, SSH)
      const claudeEnv = await this.setupEnvironment(
        workspaceRoot,
        request.environmentSecrets || {},
        proxyPort,
        request.anthropicApiKey,
        request.anthropicOAuthToken,
        sshKeyPath,
        logPrefix
      );

      // Execute pre-execution commands if provided
      if (request.preExecutionCommands && request.preExecutionCommands.length > 0) {
        await this.executePreExecutionCommands(
          request.preExecutionCommands,
          workspaceRoot,
          claudeEnv,
          logPrefix
        );
      }

      // Build Claude options
      const options = this.buildClaudeOptions(request, claudeEnv);

      // Create Claude runner
      runner = new ClaudeRunner(workspaceRoot);

      // Create data and error handlers
      const onData = (line: string) => {
        outputHandler.onData(line);
      };

      const onError = (error: string) => {
        outputHandler.onError(error);
      };

      logger.info(`${logPrefix} Starting Claude CLI`);

      // Run Claude (this will block until completion)
      const result = request.useNamedPipe !== false
        ? await runner.runWithPipe(request.prompt, options, onData, onError)
        : await runner.runDirect(request.prompt, options, onData, onError);

      // Calculate duration
      const durationMs = Date.now() - startTime;

      // Normal completion
      await outputHandler.onComplete(result, durationMs);
      logger.info(`${logPrefix} Task completed successfully in ${durationMs}ms`);


    } catch (error: any) {
      logger.error(`${logPrefix} Task failed:`, error.message, error.stack);

      // Normal error handling
      outputHandler.onError(error.message);

      // Try to complete with error status
      try {
        await outputHandler.onComplete(
          { exitCode: 1, output: '', error: error.message },
          Date.now() - startTime
        );
      } catch (completeError: any) {
        logger.error(`${logPrefix} Failed to notify completion:`, completeError.message);
      }

      // Clean up workspace immediately on error
      if (workspaceRoot) {
        await this.workspaceService.cleanupWorkspaceNow(workspaceRoot);
        cleanedUp = true;
      }

      // Re-throw to let job worker handle
      throw error;

    } finally {
      // Cleanup output handler
      try {
        await outputHandler.cleanup();
      } catch (cleanupError: any) {
        logger.error(`${logPrefix} Failed to cleanup output handler:`, cleanupError.message);
      }

      // Stop proxy
      if (proxy) {
        await proxy.stop();
        logger.debug(`${logPrefix} Proxy stopped`);
      }

      // Clean up workspace (immediate for jobs)
      if (workspaceRoot && !cleanedUp) {
        await this.workspaceService.cleanupWorkspaceNow(workspaceRoot);
        logger.debug(`${logPrefix} Workspace cleaned up`);
      }

      logger.info(`${logPrefix} Task execution finished`);
    }
  }

  /**
   * Setup and start the authentication proxy
   */
  private async setupProxy(
    anthropicApiKey?: string,
    anthropicOAuthToken?: string,
    logPrefix: string = ''
  ): Promise<{ proxy: SimpleAnthropicProxy; proxyPort: number }> {
    logger.debug(`${logPrefix} Starting token proxy`);

    const proxy = new SimpleAnthropicProxy(anthropicApiKey, anthropicOAuthToken);
    await proxy.start();
    const proxyPort = proxy.getPort();

    logger.debug(`${logPrefix} Token proxy started on 127.0.0.1:${proxyPort}`);

    // Small delay to ensure proxy is fully ready
    await new Promise(resolve => setTimeout(resolve, 100));

    return { proxy, proxyPort };
  }

  /**
   * Setup workspace: create, write SSH keys, clone git repo, write config files
   */
  private async setupWorkspace(
    request: RunRequest,
    logPrefix: string = ''
  ): Promise<{ workspaceRoot: string; sshKeyPath?: string; configFiles?: string[] }> {
    const { gitRepo, sshKey, gitBranch = 'main', gitDepth = 1 } = request;
    // Create workspace
    let workspaceRoot = await this.workspaceService.createWorkspace();
    logger.debug(`${logPrefix} Workspace created: ${workspaceRoot}`);

    let sshKeyPath: string | undefined;

    // Write SSH key if provided
    if (sshKey) {
      logger.debug(`${logPrefix} Writing SSH key (${sshKey.length} bytes)`);
      try {
        sshKeyPath = await this.workspaceService.writeSshKeyFile(workspaceRoot, sshKey);
        logger.debug(`${logPrefix} SSH key written to: ${sshKeyPath}`);
      } catch (error: any) {
        logger.error(`${logPrefix} Failed to write SSH key:`, error.message);
        throw error;
      }
    }

    // Clone repository if provided
    if (gitRepo) {
      let repoUrlToUse = gitRepo;

      // Convert HTTPS URLs to SSH format if we have an SSH key
      if (sshKey) {
        if (gitRepo.startsWith('http://') || gitRepo.startsWith('https://')) {
          repoUrlToUse = this.gitService.convertHttpsToSsh(gitRepo);
          logger.debug(`${logPrefix} Converted HTTPS URL to SSH format: ${gitRepo} -> ${repoUrlToUse}`);
        }
      } else {
        logger.debug(`${logPrefix} No SSH key provided`);

        if (gitRepo.startsWith('git@')) {
          logger.debug(`${logPrefix} SSH URL requires authentication but no SSH key available`);
        } else {
          logger.debug(`${logPrefix} Attempting public HTTPS clone`);
        }
      }

      // Clone into 'repo' subdirectory
      const repoPath = path.join(workspaceRoot, 'repo');

      await this.gitService.cloneRepository({
        gitRepo: repoUrlToUse,
        targetPath: repoPath,
        branch: gitBranch,
        depth: gitDepth,
        sshKeyPath
      });

      // Update workspaceRoot to point to cloned repository
      workspaceRoot = repoPath;
      logger.debug(`${logPrefix} Repository cloned to: ${workspaceRoot}`);

      // Initialize external test repo submodule if configured
      if (request.externalTestRepo) {
        const { url, branch, installationAccessToken, existingPrBranch, updateSubmoduleToLatest } = request.externalTestRepo;
        const tokenUrl = this.gitService.buildTokenUrl(url, installationAccessToken);

        logger.info(`${logPrefix} Initializing external test repo submodule: ${url} (branch: ${branch})`);
        await this.gitService.initSubmodule(
          workspaceRoot,
          'tests',
          url,
          tokenUrl,
          branch,
          gitDepth,
          { existingPrBranch, updateSubmoduleToLatest }
        );
        logger.info(`${logPrefix} ✓ External test repo ready at ./tests/`);
      }
    }

    // Write Claude configuration files if provided
    let configFiles: string[] | undefined;
    if (request.mcpConfig || request.slashCommands || request.subagents) {
      logger.debug(`${logPrefix} Writing Claude configuration files`);
      const configResult = await this.claudeConfigService.writeConfigFiles(
        workspaceRoot,
        request.mcpConfig,
        request.slashCommands,
        request.subagents,
        request.environmentSecrets
      );
      configFiles = configResult.createdFiles;
      logger.info(`${logPrefix} ✓ Created MCP config: ${configResult.summary.mcpConfigCreated}, ${configResult.summary.slashCommandsCount} slash commands, ${configResult.summary.subagentsCount} subagents`);
    }

    // Add prompt.txt to excluded files (created by claude-runner)
    if (configFiles) {
      configFiles.push('prompt.txt');
    } else {
      configFiles = ['prompt.txt'];
    }

    return { workspaceRoot, sshKeyPath, configFiles };
  }

  /**
   * Setup environment variables for Claude execution
   */
  private async setupEnvironment(
    workspaceRoot: string,
    environmentSecrets: Record<string, string>,
    proxyPort: number,
    anthropicApiKey?: string,
    anthropicOAuthToken?: string,
    sshKeyPath?: string,
    logPrefix: string = ''
  ): Promise<Record<string, string>> {
    // Write environment secrets to .env file
    if (Object.keys(environmentSecrets).length > 0) {
      logger.debug(`${logPrefix} Writing ${Object.keys(environmentSecrets).length} environment secrets`);
      const envContent = Object.entries(environmentSecrets)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      await this.workspaceService.writeEnvFile(workspaceRoot, envContent);
    }

    // Build Claude environment
    const claudeEnv: Record<string, string> = {
      // Proxy configuration - use ANTHROPIC_BASE_URL to only intercept Anthropic API traffic
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
      // User-provided environment secrets (intentionally accessible)
      ...environmentSecrets
    };

    // SECURITY: Pass dummy credential that matches the type we have
    // Proxy will replace it with the real credential
    if (anthropicApiKey) {
      claudeEnv.ANTHROPIC_API_KEY = 'dummy-api-key-proxy-will-replace';
    } else if (anthropicOAuthToken) {
      claudeEnv.CLAUDE_CODE_OAUTH_TOKEN = 'dummy-oauth-token-proxy-will-replace';
    }

    // Configure Git to use per-request SSH key for Claude's git commands
    if (sshKeyPath) {
      claudeEnv.GIT_SSH_COMMAND = `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      logger.debug(`${logPrefix} GIT_SSH_COMMAND configured`);
    }

    return claudeEnv;
  }

  /**
   * Execute pre-execution commands before starting Claude
   */
  private async executePreExecutionCommands(
    commands: string[],
    workspaceRoot: string,
    env: Record<string, string>,
    logPrefix: string = ''
  ): Promise<void> {
    logger.info(`${logPrefix} Executing ${commands.length} pre-execution command(s) in: ${workspaceRoot}`);

    // Build clean environment without npm-specific vars that could cause issues
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      // Skip npm_ prefixed vars that could interfere with npm commands
      if (key.startsWith('npm_') || key === 'NODE_PATH' || key === 'PWD') {
        continue;
      }
      if (value !== undefined) {
        cleanEnv[key] = value;
      }
    }

    for (const [index, command] of commands.entries()) {
      const commandNumber = index + 1;
      logger.info(`${logPrefix} [${commandNumber}/${commands.length}] Running: ${command}`);

      try {
        const startTime = Date.now();

        // Execute command with cleaned environment and in the workspace directory
        const output = execSync(command, {
          cwd: workspaceRoot,
          env: {
            ...cleanEnv,
            ...env,
            // Ensure npm/pnpm use CI mode
            CI: 'true',
            // Explicitly set HOME for npm config location
            HOME: process.env.HOME || '/home/claudeuser',
            // Override production NODE_ENV so npm install includes devDependencies
            NODE_ENV: '',
          },
          encoding: 'utf-8',
          // 5 minute timeout per command
          timeout: 300000,
          // Capture both stdout and stderr
          stdio: 'pipe'
        });

        const durationMs = Date.now() - startTime;
        logger.info(`${logPrefix} [${commandNumber}/${commands.length}] ✓ Completed in ${durationMs}ms`);

        // Log output if present (truncate if too long)
        if (output && output.trim()) {
          const truncatedOutput = output.length > 500
            ? output.substring(0, 500) + '... (truncated)'
            : output;
          logger.debug(`${logPrefix} [${commandNumber}/${commands.length}] Output: ${truncatedOutput}`);
        }

      } catch (error: any) {
        logger.error(`${logPrefix} [${commandNumber}/${commands.length}] ✗ Command failed: ${command}`);
        logger.error(`${logPrefix} [${commandNumber}/${commands.length}] Error: ${error.message}`);

        // Log stderr if available
        if (error.stderr) {
          logger.error(`${logPrefix} [${commandNumber}/${commands.length}] stderr: ${error.stderr.toString()}`);
        }

        // Log stdout if available (some commands output to stdout even on failure)
        if (error.stdout) {
          logger.debug(`${logPrefix} [${commandNumber}/${commands.length}] stdout: ${error.stdout.toString()}`);
        }

        // Fail fast - don't continue with remaining commands
        throw new Error(`Pre-execution command failed: ${command}\n${error.message}`);
      }
    }

    logger.info(`${logPrefix} ✓ All pre-execution commands completed successfully`);
  }

  /**
   * Build Claude options from request
   */
  private buildClaudeOptions(
    request: RunRequest,
    claudeEnv: Record<string, string>
  ): ClaudeOptions {
    return {
      allowedTools: request.allowedTools,
      disallowedTools: request.disallowedTools,
      maxTurns: request.maxTurns,
      systemPrompt: request.systemPrompt,
      appendSystemPrompt: request.appendSystemPrompt,
      permissionMode: request.permissionMode,
      timeoutMinutes: request.timeoutMinutes || 55,
      model: request.model,
      fallbackModel: request.fallbackModel,
      dangerouslySkipPermissions: process.env.DANGEROUSLY_SKIP_PERMISSIONS === 'true',
      debug: process.env.CLAUDE_DEBUG === 'true',
      claudeEnv
    };
  }
}
