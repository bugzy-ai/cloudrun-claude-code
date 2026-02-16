import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitService } from "../../src/api/services/git.service.js";

// Mock simple-git
const mockGit = {
  raw: vi.fn().mockResolvedValue(''),
  status: vi.fn().mockResolvedValue({ files: [] }),
  checkoutLocalBranch: vi.fn().mockResolvedValue(undefined),
  add: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue({ commit: 'abc1234' }),
  push: vi.fn().mockResolvedValue(undefined),
  addConfig: vi.fn().mockResolvedValue(undefined),
};

vi.mock("simple-git", () => ({
  default: vi.fn(() => mockGit),
}));

// Mock fs
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "fs";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

// Mock global fetch for createPullRequest
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.restoreAllMocks();
  // Reset mocks to defaults
  mockGit.raw.mockResolvedValue('');
  mockGit.status.mockResolvedValue({ files: [] });
  mockGit.checkoutLocalBranch.mockResolvedValue(undefined);
  mockGit.add.mockResolvedValue(undefined);
  mockGit.commit.mockResolvedValue({ commit: 'abc1234' });
  mockGit.push.mockResolvedValue(undefined);
  mockGit.addConfig.mockResolvedValue(undefined);
});

describe('GitService - Submodule Operations', () => {
  let gitService: GitService;

  beforeEach(() => {
    gitService = new GitService();
  });

  describe('parseGitHubUrl', () => {
    it('should parse a standard GitHub HTTPS URL', () => {
      const result = gitService.parseGitHubUrl('https://github.com/acme/test-repo');
      expect(result).toEqual({ owner: 'acme', repo: 'test-repo' });
    });

    it('should parse a URL with .git suffix', () => {
      const result = gitService.parseGitHubUrl('https://github.com/acme/test-repo.git');
      expect(result).toEqual({ owner: 'acme', repo: 'test-repo' });
    });

    it('should throw for non-GitHub URLs', () => {
      expect(() => gitService.parseGitHubUrl('https://gitlab.com/acme/repo'))
        .toThrow('Cannot parse GitHub owner/repo from URL');
    });
  });

  describe('buildTokenUrl', () => {
    it('should build a token-authenticated URL', () => {
      const url = gitService.buildTokenUrl('https://github.com/acme/tests', 'ghs_abc123');
      expect(url).toBe('https://x-access-token:ghs_abc123@github.com/acme/tests.git');
    });
  });

  describe('initSubmodule', () => {
    it('should add submodule on first run (no .gitmodules)', async () => {
      mockedExistsSync.mockReturnValue(false);

      await gitService.initSubmodule(
        '/workspace/repo',
        'tests',
        'https://github.com/acme/tests',
        'https://x-access-token:tok@github.com/acme/tests.git',
        'main',
        1
      );

      expect(mockGit.raw).toHaveBeenCalledWith([
        'submodule', 'add',
        '--depth', '1',
        '-b', 'main',
        'https://x-access-token:tok@github.com/acme/tests.git',
        'tests'
      ]);
    });

    it('should update existing submodule on subsequent runs', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('[submodule "tests"]\n\tpath = tests\n\turl = ...');

      await gitService.initSubmodule(
        '/workspace/repo',
        'tests',
        'https://github.com/acme/tests',
        'https://x-access-token:tok@github.com/acme/tests.git',
        'main',
        1
      );

      expect(mockGit.raw).toHaveBeenCalledWith(['config', 'submodule.tests.url', 'https://x-access-token:tok@github.com/acme/tests.git']);
      expect(mockGit.raw).toHaveBeenCalledWith(['submodule', 'update', '--init', '--depth', '1', 'tests']);
    });

    it('should throw a clear error if tests/ directory already exists', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockGit.raw.mockRejectedValueOnce(new Error("'tests' already exists in the working tree"));

      await expect(gitService.initSubmodule(
        '/workspace/repo', 'tests',
        'https://github.com/acme/tests',
        'https://x-access-token:tok@github.com/acme/tests.git'
      )).rejects.toThrow("Cannot add submodule at 'tests'");
    });
  });

  describe('hasSubmoduleChanges', () => {
    it('should return false if submodule path does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);
      const result = await gitService.hasSubmoduleChanges('/workspace/repo', 'tests');
      expect(result).toBe(false);
    });

    it('should return true if submodule has changes', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockGit.status.mockResolvedValue({ files: [{ path: 'new-test.spec.ts' }] });

      const result = await gitService.hasSubmoduleChanges('/workspace/repo', 'tests');
      expect(result).toBe(true);
    });

    it('should return false if submodule has no changes', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockGit.status.mockResolvedValue({ files: [] });

      const result = await gitService.hasSubmoduleChanges('/workspace/repo', 'tests');
      expect(result).toBe(false);
    });
  });

  describe('commitAndPushSubmodule', () => {
    beforeEach(() => {
      // configureIdentity reads .gitconfig — mock fs for that
      mockedExistsSync.mockReturnValue(false);
    });

    it('should create branch, commit, set remote, and push', async () => {
      const result = await gitService.commitAndPushSubmodule(
        '/workspace/repo',
        'tests',
        'bugzy/fix-login-test-abc123',
        'fix: update login test assertions',
        'https://x-access-token:tok@github.com/acme/tests.git'
      );

      expect(result.sha).toBe('abc1234');
      expect(mockGit.checkoutLocalBranch).toHaveBeenCalledWith('bugzy/fix-login-test-abc123');
      expect(mockGit.add).toHaveBeenCalledWith('-A');
      expect(mockGit.commit).toHaveBeenCalledWith('fix: update login test assertions');
      expect(mockGit.raw).toHaveBeenCalledWith([
        'remote', 'set-url', 'origin',
        'https://x-access-token:tok@github.com/acme/tests.git'
      ]);
      expect(mockGit.push).toHaveBeenCalledWith(['-u', 'origin', 'bugzy/fix-login-test-abc123']);
    });
  });

  describe('createPullRequest', () => {
    it('should create a PR and return number and URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ number: 42, html_url: 'https://github.com/acme/tests/pull/42' }),
      });

      const result = await gitService.createPullRequest(
        'acme', 'tests',
        'bugzy/fix-login-test-abc123', 'main',
        'fix: update login test', 'Auto-generated by Bugzy',
        'ghs_token123'
      );

      expect(result).toEqual({ number: 42, url: 'https://github.com/acme/tests/pull/42' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/acme/tests/pulls',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer ghs_token123',
          }),
        })
      );
    });

    it('should throw on GitHub API error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => '{"message":"Validation Failed"}',
      });

      await expect(gitService.createPullRequest(
        'acme', 'tests',
        'bugzy/fix', 'main',
        'title', 'body', 'token'
      )).rejects.toThrow('GitHub API returned 422');
    });
  });
});
