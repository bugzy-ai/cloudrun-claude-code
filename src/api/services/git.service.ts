import simpleGit from "simple-git";
import { logger } from "../../utils/logger.js";
import * as fs from "fs";
import * as path from "path";

export interface GitCloneOptions {
  gitRepo: string;
  targetPath: string;
  branch?: string;
  depth?: number;
  sshKeyPath?: string;
}

export class GitService {
  // Validate git repository URL
  isValidGitUrl(gitRepo: string): boolean {
    return !!gitRepo.match(/^(git@|https?:\/\/)/);
  }

  // Convert HTTPS GitHub URL to SSH format
  convertHttpsToSsh(httpsUrl: string): string {
    // Match: https://github.com/owner/repo or https://github.com/owner/repo.git
    const match = httpsUrl.match(/https?:\/\/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (match) {
      const [, owner, repo] = match;
      return `git@github.com:${owner}/${repo}.git`;
    }
    return httpsUrl;
  }

  // Clone a git repository
  async cloneRepository(options: GitCloneOptions): Promise<void> {
    const { gitRepo, targetPath, branch = 'main', depth = 1, sshKeyPath } = options;

    if (!this.isValidGitUrl(gitRepo)) {
      throw new Error("Invalid git repository URL format. Use SSH (git@...) or HTTPS format.");
    }

    const isHttps = gitRepo.startsWith('http://') || gitRepo.startsWith('https://');
    const isSsh = gitRepo.startsWith('git@');

    logger.debug(`Cloning repository: ${gitRepo} (branch: ${branch}, depth: ${depth}, protocol: ${isHttps ? 'HTTPS' : 'SSH'})`);
    if (sshKeyPath) {
      logger.debug(`Using SSH key: ${sshKeyPath}`);
    }

    try {
      // Create a fresh SimpleGit instance to avoid carrying environment state between clones
      const git = simpleGit({
        baseDir: '/tmp',
        binary: 'git',
        maxConcurrentProcesses: 1,
        trimmed: false,
      });

      // Configure SSH key if provided and using SSH protocol
      if (sshKeyPath && isSsh) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      // For HTTPS URLs, disable credential prompts to avoid hanging on auth requests
      if (isHttps) {
        git.env('GIT_TERMINAL_PROMPT', '0');
        git.env('GIT_ASKPASS', 'echo');
      }

      // Set timeout for git operations (30 seconds)
      const clonePromise = git.clone(gitRepo, targetPath, [
        '--branch', branch,
        '--depth', depth.toString(),
        '--single-branch'
      ]);

      // Add timeout wrapper
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Git clone operation timed out after 30 seconds')), 30000);
      });

      await Promise.race([clonePromise, timeoutPromise]);
      logger.debug("✓ Repository cloned successfully");
    } catch (error: any) {
      // Log the actual error for debugging
      logger.error("Git clone failed with error:", error.message);

      // Provide more helpful error messages
      let errorMessage = error.message;
      if (error.message.includes('Could not read from remote repository')) {
        errorMessage = 'Authentication failed or repository not accessible. Ensure SSH key is properly configured.';
      } else if (error.message.includes('Repository not found')) {
        errorMessage = 'Repository not found. Check the repository URL and access permissions.';
      } else if (error.message.includes('timed out')) {
        errorMessage = 'Git clone operation timed out. Repository may be too large or network is slow.';
      } else if (error.message.includes('Permission denied')) {
        errorMessage = 'SSH key authentication failed. Check SSH key permissions and GitHub access.';
      } else if (error.message.includes('Host key verification failed')) {
        errorMessage = 'SSH host key verification failed. This should be handled by StrictHostKeyChecking=no.';
      }

      throw new Error(`Failed to clone repository: ${errorMessage}`);
    }
  }

  /**
   * Configure git user identity for commits
   * Must be called before any git operations that require author info (commit, merge, etc.)
   *
   * Reads identity from .gitconfig in repository root if available, otherwise uses defaults
   */
  async configureIdentity(
    workspacePath: string,
    name?: string,
    email?: string
  ): Promise<void> {
    try {
      // Try to read from .gitconfig in repository root if name/email not explicitly provided
      if (!name || !email) {
        const gitConfigPath = path.join(workspacePath, '.gitconfig');

        if (fs.existsSync(gitConfigPath)) {
          try {
            const configContent = fs.readFileSync(gitConfigPath, 'utf-8');

            // Parse [user] section for name and email
            // Regex matches:  name = Value  or  name=Value
            const nameMatch = configContent.match(/\[user\][\s\S]*?\bname\s*=\s*(.+)/);
            const emailMatch = configContent.match(/\[user\][\s\S]*?\bemail\s*=\s*(.+)/);

            if (nameMatch && !name) {
              name = nameMatch[1].trim();
            }
            if (emailMatch && !email) {
              email = emailMatch[1].trim();
            }

            if (nameMatch || emailMatch) {
              logger.debug(`Read git identity from .gitconfig: ${name || '(default)'} <${email || '(default)'}>`);
            }
          } catch (readError: any) {
            logger.debug(`Could not read .gitconfig: ${readError.message}`);
          }
        }
      }

      // Use defaults if still not set
      name = name || 'Claude Code';
      email = email || 'noreply@anthropic.com';

      const git = simpleGit(workspacePath);

      // Set local git config for this repository
      await git.addConfig('user.name', name, false, 'local');
      await git.addConfig('user.email', email, false, 'local');

      logger.debug(`✓ Git identity configured: ${name} <${email}>`);
    } catch (error: any) {
      logger.error('Failed to configure git identity:', error.message);
      throw new Error(`Failed to configure git identity: ${error.message}`);
    }
  }

  /**
   * Check if workspace has uncommitted changes
   */
  async hasChanges(workspacePath: string): Promise<boolean> {
    try {
      const git = simpleGit(workspacePath);
      const status = await git.status();

      // Check for modified, added, deleted, or untracked files
      const hasChanges = status.files.length > 0;

      if (hasChanges) {
        logger.debug(`Workspace has ${status.files.length} changed files`);
      } else {
        logger.debug('Workspace has no changes');
      }

      return hasChanges;
    } catch (error: any) {
      logger.error('Failed to check git status:', error.message);
      throw new Error(`Failed to check for changes: ${error.message}`);
    }
  }

  /**
   * Get list of changed files (modified, added, deleted, untracked)
   */
  async getChangedFiles(workspacePath: string): Promise<string[]> {
    try {
      const git = simpleGit(workspacePath);
      const status = await git.status();

      // Return all file paths that have changes
      const changedFiles = status.files.map(file => file.path);

      logger.debug(`Found ${changedFiles.length} changed files`);

      return changedFiles;
    } catch (error: any) {
      logger.error('Failed to get changed files:', error.message);
      throw new Error(`Failed to get changed files: ${error.message}`);
    }
  }

  /**
   * Commit changes in workspace
   * Optionally specify files to commit (defaults to all changes)
   */
  async commit(
    workspacePath: string,
    message: string,
    files?: string[],
    sshKeyPath?: string
  ): Promise<{ sha: string; message: string }> {
    try {
      // Configure git identity BEFORE any git operations
      await this.configureIdentity(workspacePath);

      const git = simpleGit(workspacePath);

      // Configure SSH key if provided
      if (sshKeyPath) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      // Stage files
      if (files && files.length > 0) {
        logger.debug(`Staging specific files: ${files.join(', ')}`);
        await git.add(files);
      } else {
        logger.debug('Staging all changes');
        await git.add('-A');
      }

      // Check if there's anything to commit after staging
      const status = await git.status();
      logger.debug(`Staged: ${status.staged.length} files, Renamed: ${status.renamed.length} files`);
      if (status.staged.length === 0 && status.renamed.length === 0) {
        logger.debug('No changes staged for commit');
        throw new Error('No changes to commit after staging');
      }

      // Create commit
      logger.debug(`Creating commit with ${status.staged.length} staged files`);
      const commitResult = await git.commit(message);

      logger.debug(`✓ Commit created: ${commitResult.commit}`);

      return {
        sha: commitResult.commit,
        message: message
      };
    } catch (error: any) {
      logger.error('Failed to commit changes:', error.message);
      throw new Error(`Failed to commit: ${error.message}`);
    }
  }

  /**
   * Fetch from remote repository
   */
  async fetch(
    workspacePath: string,
    branch: string = 'main',
    sshKeyPath?: string
  ): Promise<void> {
    try {
      const git = simpleGit(workspacePath);

      // Configure SSH key if provided
      if (sshKeyPath) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      logger.debug(`Fetching from remote (branch: ${branch})`);

      await git.fetch('origin', branch);

      logger.debug('✓ Fetch completed successfully');
    } catch (error: any) {
      logger.error('Failed to fetch from remote:', error.message);
      throw new Error(`Failed to fetch: ${error.message}`);
    }
  }

  /**
   * Get remote HEAD SHA for a branch
   */
  async getRemoteHead(
    workspacePath: string,
    branch: string = 'main'
  ): Promise<string> {
    try {
      const git = simpleGit(workspacePath);
      const result = await git.raw(['rev-parse', `origin/${branch}`]);
      return result.trim();
    } catch (error: any) {
      logger.error('Failed to get remote HEAD:', error.message);
      throw new Error(`Failed to get remote HEAD: ${error.message}`);
    }
  }

  /**
   * Get local HEAD SHA
   */
  async getLocalHead(workspacePath: string): Promise<string> {
    try {
      const git = simpleGit(workspacePath);
      const result = await git.raw(['rev-parse', 'HEAD']);
      return result.trim();
    } catch (error: any) {
      logger.error('Failed to get local HEAD:', error.message);
      throw new Error(`Failed to get local HEAD: ${error.message}`);
    }
  }

  /**
   * Check if repository is a shallow clone
   */
  async isShallow(workspacePath: string): Promise<boolean> {
    try {
      const shallowFile = path.join(workspacePath, '.git', 'shallow');
      return fs.existsSync(shallowFile);
    } catch (error: any) {
      logger.error('Failed to check if shallow:', error.message);
      return false;
    }
  }

  /**
   * Convert shallow clone to full clone
   */
  async unshallow(
    workspacePath: string,
    sshKeyPath?: string
  ): Promise<void> {
    try {
      const git = simpleGit(workspacePath);

      // Configure SSH key if provided
      if (sshKeyPath) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      logger.debug('Converting shallow clone to full clone');

      await git.fetch(['--unshallow']);

      logger.debug('✓ Repository unshallowed successfully');
    } catch (error: any) {
      logger.error('Failed to unshallow repository:', error.message);
      throw new Error(`Failed to unshallow: ${error.message}`);
    }
  }

  /**
   * Rebase onto remote branch with conflict resolution strategy
   */
  async rebaseWithStrategy(
    workspacePath: string,
    branch: string = 'main',
    strategy: 'ours' | 'theirs' = 'ours'
  ): Promise<{ success: boolean; conflictFiles?: string[] }> {
    try {
      const git = simpleGit(workspacePath);

      logger.debug(`Rebasing onto origin/${branch} with strategy: ${strategy}`);

      try {
        // Attempt rebase with conflict resolution strategy
        await git.raw(['rebase', `origin/${branch}`, '-X', strategy]);

        logger.debug('✓ Rebase completed successfully');
        return { success: true };
      } catch (rebaseError: any) {
        // Check if there are conflicts
        const status = await git.status();
        const conflictFiles = status.conflicted;

        if (conflictFiles.length > 0) {
          logger.warn(`Rebase failed with ${conflictFiles.length} conflicted files:`, conflictFiles);

          // Abort the rebase to clean up
          try {
            await git.rebase(['--abort']);
          } catch (abortError) {
            logger.error('Failed to abort rebase:', abortError);
          }

          return { success: false, conflictFiles };
        }

        throw rebaseError;
      }
    } catch (error: any) {
      logger.error('Failed to rebase:', error.message);
      throw new Error(`Failed to rebase: ${error.message}`);
    }
  }

  /**
   * Push with --force-with-lease (safer force push)
   */
  async pushWithLease(
    workspacePath: string,
    branch: string = 'main',
    sshKeyPath?: string
  ): Promise<void> {
    try {
      const git = simpleGit(workspacePath);

      // Configure SSH key if provided
      if (sshKeyPath) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      logger.debug(`Force pushing with --force-with-lease to ${branch}`);

      // Push with timeout
      const pushPromise = git.push('origin', branch, ['--force-with-lease']);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Git push operation timed out after 30 seconds')), 30000);
      });

      await Promise.race([pushPromise, timeoutPromise]);

      logger.debug('✓ Force push with lease completed successfully');
    } catch (error: any) {
      logger.error('Failed to force push with lease:', error.message);
      throw new Error(`Failed to force push with lease: ${error.message}`);
    }
  }

  /**
   * Push commits to remote repository with automatic conflict recovery
   */
  async push(
    workspacePath: string,
    branch: string = 'main',
    sshKeyPath?: string,
    conflictStrategy: "auto" | "fail" = "auto"
  ): Promise<{
    success: boolean;
    recovery?: {
      method: "rebase" | "force-with-lease";
      remoteSha: string;
      conflictFiles?: string[];
    };
  }> {
    try {
      const git = simpleGit(workspacePath);

      // Configure SSH key if provided
      if (sshKeyPath) {
        git.env('GIT_SSH_COMMAND', `ssh -i ${sshKeyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`);
      }

      logger.debug(`Pushing to remote (branch: ${branch}, conflictStrategy: ${conflictStrategy})`);

      // Attempt normal push first
      try {
        const pushPromise = git.push('origin', branch);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('Git push operation timed out after 30 seconds')), 30000);
        });

        await Promise.race([pushPromise, timeoutPromise]);

        logger.debug('✓ Push completed successfully (no conflicts)');
        return { success: true };
      } catch (pushError: any) {
        // Check if push was rejected due to non-fast-forward
        const isRejected = pushError.message.includes('rejected') ||
                          pushError.message.includes('non-fast-forward') ||
                          pushError.message.includes('Updates were rejected');

        if (!isRejected) {
          // Not a conflict - re-throw the error
          throw pushError;
        }

        logger.warn('Push rejected - remote has diverged from local');

        // If strategy is "fail", throw error immediately
        if (conflictStrategy === "fail") {
          throw new Error('Push rejected. Remote has changes that are not in local branch. Use conflictStrategy: "auto" to enable automatic recovery.');
        }

        // Strategy is "auto" - attempt recovery
        logger.info('Attempting automatic recovery (agent changes will take priority)');

        // 1. Fetch remote changes
        logger.debug('Fetching remote changes');
        await this.fetch(workspacePath, branch, sshKeyPath);

        // 2. Get remote SHA before recovery
        const remoteSha = await this.getRemoteHead(workspacePath, branch);
        logger.debug(`Remote HEAD: ${remoteSha}`);

        // 3. Check if repository is shallow - if so, unshallow for rebase
        const shallow = await this.isShallow(workspacePath);
        if (shallow) {
          logger.debug('Repository is shallow - unshallowing for rebase');
          await this.unshallow(workspacePath, sshKeyPath);
        }

        // 4. Attempt rebase with "ours" strategy (agent changes win)
        logger.info('Attempting rebase with conflict resolution (agent changes win)');
        const rebaseResult = await this.rebaseWithStrategy(workspacePath, branch, 'ours');

        if (rebaseResult.success) {
          // Rebase succeeded - push normally
          logger.info('✓ Rebase successful - pushing rebased commits');

          const pushPromise = git.push('origin', branch);
          const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Git push operation timed out after 30 seconds')), 30000);
          });

          await Promise.race([pushPromise, timeoutPromise]);

          logger.info('✓ Push completed successfully after rebase recovery');

          return {
            success: true,
            recovery: {
              method: 'rebase',
              remoteSha,
              conflictFiles: rebaseResult.conflictFiles
            }
          };
        } else {
          // Rebase failed with conflicts - use force-with-lease as fallback
          logger.warn(`Rebase failed with conflicts in ${rebaseResult.conflictFiles?.length || 0} files - falling back to force-with-lease`);

          await this.pushWithLease(workspacePath, branch, sshKeyPath);

          logger.info('✓ Push completed successfully with force-with-lease recovery');

          return {
            success: true,
            recovery: {
              method: 'force-with-lease',
              remoteSha,
              conflictFiles: rebaseResult.conflictFiles
            }
          };
        }
      }
    } catch (error: any) {
      logger.error('Failed to push changes:', error.message);

      // Provide helpful error messages
      let errorMessage = error.message;
      if (error.message.includes('Could not read from remote repository')) {
        errorMessage = 'Authentication failed. Ensure SSH key has write access to the repository.';
      } else if (error.message.includes('Permission denied')) {
        errorMessage = 'SSH key authentication failed or insufficient permissions.';
      }

      throw new Error(`Failed to push: ${errorMessage}`);
    }
  }

  // =========================================================================
  // Submodule Operations (for External Test Repo / BYOT)
  // =========================================================================

  /**
   * Parse owner and repo name from a GitHub HTTPS URL
   * e.g., "https://github.com/org/repo" → { owner: "org", repo: "repo" }
   */
  parseGitHubUrl(url: string): { owner: string; repo: string } {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+?)(\.git)?$/);
    if (!match) {
      throw new Error(`Cannot parse GitHub owner/repo from URL: ${url}`);
    }
    return { owner: match[1], repo: match[2] };
  }

  /**
   * Build an HTTPS token-authenticated URL for git operations
   * e.g., "https://x-access-token:{token}@github.com/org/repo.git"
   */
  buildTokenUrl(url: string, token: string): string {
    const { owner, repo } = this.parseGitHubUrl(url);
    return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  }

  /**
   * Initialize an external test repo as a git submodule at the given path.
   *
   * Two-path logic:
   * 1. If submodule not yet registered in .gitmodules → `git submodule add`
   * 2. If already registered → override URL with token and `git submodule update --init`
   *
   * @param workspacePath - Root of the parent repo
   * @param submodulePath - Relative path where submodule should live (e.g., "tests")
   * @param repoUrl - Original HTTPS URL (for display/reference)
   * @param tokenUrl - Token-authenticated URL for actual clone
   * @param branch - Branch to checkout in the submodule
   * @param depth - Clone depth (default: 1 for shallow)
   */
  async initSubmodule(
    workspacePath: string,
    submodulePath: string,
    repoUrl: string,
    tokenUrl: string,
    branch: string = 'main',
    depth: number = 1,
    options?: {
      /** Check out an existing PR branch after init (for PR iteration) */
      existingPrBranch?: string;
      /** Pull latest from base branch to advance HEAD (for merge events) */
      updateSubmoduleToLatest?: boolean;
    }
  ): Promise<void> {
    try {
      const git = simpleGit(workspacePath);
      const gitmodulesPath = path.join(workspacePath, '.gitmodules');

      const isRegistered = fs.existsSync(gitmodulesPath) &&
        fs.readFileSync(gitmodulesPath, 'utf-8').includes(`[submodule "${submodulePath}"]`);

      if (!isRegistered) {
        // First run: add the submodule
        logger.info(`Adding submodule at ${submodulePath} (first run)`);
        await git.raw([
          'submodule', 'add',
          '--depth', depth.toString(),
          '-b', branch,
          tokenUrl,
          submodulePath
        ]);
        logger.info(`✓ Submodule added at ${submodulePath}`);
      } else {
        // Subsequent run: override URL with token and init
        logger.info(`Initializing existing submodule at ${submodulePath}`);
        await git.raw(['config', `submodule.${submodulePath}.url`, tokenUrl]);
        await git.raw([
          'submodule', 'update', '--init',
          '--depth', depth.toString(),
          submodulePath
        ]);
        logger.info(`✓ Submodule initialized at ${submodulePath}`);
      }

      // Post-init: check out existing PR branch or pull latest
      const submoduleFullPath = path.join(workspacePath, submodulePath);
      const subGit = simpleGit(submoduleFullPath);

      if (options?.existingPrBranch) {
        // Fetch and checkout the existing PR branch for iteration
        logger.info(`Fetching and checking out existing PR branch: ${options.existingPrBranch}`);
        await subGit.raw(['remote', 'set-url', 'origin', tokenUrl]);
        await subGit.fetch(['origin', options.existingPrBranch, '--depth', depth.toString()]);
        await subGit.checkout(options.existingPrBranch);
        logger.info(`✓ Checked out existing PR branch: ${options.existingPrBranch}`);
      } else {
        // Always start from latest base branch — prevents stale submodule pointer
        // issues and old commits leaking into new PRs
        logger.info(`Fetching latest from base branch: ${branch}`);
        await subGit.raw(['remote', 'set-url', 'origin', tokenUrl]);
        await subGit.fetch(['origin', branch, '--depth', depth.toString()]);
        await subGit.raw(['reset', '--hard', `origin/${branch}`]);
        logger.info(`✓ Submodule HEAD at latest ${branch}`);
      }
    } catch (error: any) {
      logger.error(`Failed to init submodule at ${submodulePath}:`, error.message);

      if (error.message.includes('already exists') && !error.message.includes('submodule')) {
        throw new Error(
          `Cannot add submodule at '${submodulePath}' — a regular directory already exists there. ` +
          `The external test repo requires that '${submodulePath}/' does not already exist as a regular directory.`
        );
      }

      throw new Error(`Failed to initialize submodule: ${error.message}`);
    }
  }

  /**
   * Check if the submodule working tree has uncommitted changes
   */
  async hasSubmoduleChanges(workspacePath: string, submodulePath: string): Promise<boolean> {
    try {
      const submoduleFullPath = path.join(workspacePath, submodulePath);

      if (!fs.existsSync(submoduleFullPath)) {
        logger.debug(`Submodule path does not exist: ${submoduleFullPath}`);
        return false;
      }

      const git = simpleGit(submoduleFullPath);
      const status = await git.status();

      const hasChanges = status.files.length > 0;
      if (hasChanges) {
        logger.debug(`Submodule ${submodulePath} has ${status.files.length} changed files`);
      } else {
        logger.debug(`Submodule ${submodulePath} has no changes`);
      }

      return hasChanges;
    } catch (error: any) {
      logger.error(`Failed to check submodule changes at ${submodulePath}:`, error.message);
      throw new Error(`Failed to check submodule changes: ${error.message}`);
    }
  }

  /**
   * Commit and push changes in the submodule to a new branch.
   * Creates a branch, stages all changes, commits, and pushes.
   *
   * @returns The commit SHA
   */
  async commitAndPushSubmodule(
    workspacePath: string,
    submodulePath: string,
    branch: string,
    message: string,
    tokenUrl: string,
    options?: {
      /** When true, skip branch creation (already on the branch from initSubmodule) */
      isExistingBranch?: boolean;
    }
  ): Promise<{ sha: string }> {
    try {
      const submoduleFullPath = path.join(workspacePath, submodulePath);
      const git = simpleGit(submoduleFullPath);

      // Configure identity
      await this.configureIdentity(submoduleFullPath);

      if (!options?.isExistingBranch) {
        // Create and checkout new branch
        logger.debug(`Creating branch ${branch} in submodule ${submodulePath}`);
        await git.checkoutLocalBranch(branch);
      } else {
        logger.debug(`Using existing branch ${branch} in submodule ${submodulePath}`);
      }

      // Stage all changes
      await git.add('-A');

      // Commit
      const commitResult = await git.commit(message);
      logger.info(`✓ Submodule commit: ${commitResult.commit}`);

      // Set remote URL to token-authenticated URL and push
      await git.raw(['remote', 'set-url', 'origin', tokenUrl]);
      await git.push(['-u', 'origin', branch]);
      logger.info(`✓ Submodule pushed to ${branch}`);

      return { sha: commitResult.commit };
    } catch (error: any) {
      logger.error(`Failed to commit and push submodule ${submodulePath}:`, error.message);
      throw new Error(`Failed to commit and push submodule: ${error.message}`);
    }
  }

  /**
   * Create a pull request on a GitHub repository using the REST API.
   *
   * @returns PR number and URL
   */
  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string,
    token: string
  ): Promise<{ number: number; url: string }> {
    try {
      logger.info(`Creating PR: ${owner}/${repo} ${head} → ${base}`);

      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'bugzy-cloudrun-claude-code',
        },
        body: JSON.stringify({ title, body, head, base }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`GitHub API returned ${response.status}: ${errorBody}`);
      }

      const pr = await response.json() as { number: number; html_url: string };
      logger.info(`✓ PR created: ${pr.html_url}`);

      return { number: pr.number, url: pr.html_url };
    } catch (error: any) {
      logger.error(`Failed to create PR on ${owner}/${repo}:`, error.message);
      throw new Error(`Failed to create pull request: ${error.message}`);
    }
  }

  /**
   * Commit and push changes in one operation
   * Convenience method that combines commit + push
   */
  async commitAndPush(
    workspacePath: string,
    message: string,
    options: {
      files?: string[];
      branch?: string;
      sshKeyPath?: string;
      conflictStrategy?: "auto" | "fail";
    } = {}
  ): Promise<{
    sha: string;
    message: string;
    pushed: boolean;
    recovery?: {
      method: "rebase" | "force-with-lease";
      remoteSha: string;
      conflictFiles?: string[];
    };
  }> {
    const { files, branch = 'main', sshKeyPath, conflictStrategy = 'auto' } = options;

    // Check if there are changes
    const hasChanges = await this.hasChanges(workspacePath);
    if (!hasChanges) {
      logger.info('No changes to commit and push');
      throw new Error('No changes to commit');
    }

    // Commit
    const commitResult = await this.commit(workspacePath, message, files, sshKeyPath);

    // Push with conflict strategy
    const pushResult = await this.push(workspacePath, branch, sshKeyPath, conflictStrategy);

    return {
      ...commitResult,
      pushed: pushResult.success,
      recovery: pushResult.recovery
    };
  }
}