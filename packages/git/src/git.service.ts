import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { GitError } from './errors';
import {
  assertSafeGitRef,
  assertSafeRemoteUrl,
  isPlaceholderGitUrl,
  parseGitRemote,
} from './parse';
import type {
  DetectedRepository,
  GitAuthContext,
  GitCommitInfo,
  RemoteCommitInfo,
} from './types';

const DEFAULT_CLONE_TIMEOUT_MS = 180_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export class GitService {
  workspaceDir(projectId: string): string {
    const root = process.env.LAUNCHOS_GIT_ROOT?.trim() || join(tmpdir(), 'launchos-repos');
    return join(root, projectId);
  }

  async cloneRepository(
    url: string,
    directory: string,
    branch?: string,
    auth?: GitAuthContext,
  ): Promise<string> {
    const remote = assertSafeRemoteUrl(url);
    const ref = branch ? assertSafeGitRef(branch, '代码版本') : undefined;
    await rm(directory, { recursive: true, force: true });

    // Prefer GitHub API tarball when token is available — git clone to github.com:443
    // frequently times out from Alpha regions while api.github.com still works.
    const preferTarball =
      Boolean(auth?.token) &&
      isGitHubHttpsRemote(remote) &&
      (process.env.LAUNCHOS_PREFER_GITHUB_TARBALL || '1') !== '0';
    if (preferTarball && auth?.token) {
      try {
        await cloneGitHubViaTarball(remote, directory, ref || 'HEAD', auth.token);
        console.log(`LaunchOS Git fetched ${redactUrl(remote)} via GitHub tarball into ${directory}`);
        return directory;
      } catch (tarballError) {
        console.warn(
          `LaunchOS Git tarball fallback failed, trying git clone: ${
            tarballError instanceof Error ? tarballError.message : String(tarballError)
          }`,
        );
        await rm(directory, { recursive: true, force: true });
      }
    }

    const args = ['clone', '--quiet', '--depth', '1'];
    if (ref) {
      args.push('--branch', ref, '--single-branch');
    }
    args.push(remote, directory);

    try {
      await runGit(args, {
        timeoutMs: DEFAULT_CLONE_TIMEOUT_MS,
        auth,
      });
      console.log(`LaunchOS Git cloned ${redactUrl(remote)} into ${directory}`);
      return directory;
    } catch (error) {
      if (auth?.token && isGitHubHttpsRemote(remote)) {
        await rm(directory, { recursive: true, force: true });
        await cloneGitHubViaTarball(remote, directory, ref || 'HEAD', auth.token);
        console.log(`LaunchOS Git fetched ${redactUrl(remote)} via GitHub tarball into ${directory}`);
        return directory;
      }
      throw error;
    }
  }

  async checkoutBranch(repoDir: string, branch: string): Promise<void> {
    const ref = assertSafeGitRef(branch, '代码版本');
    await runGit(['checkout', '--quiet', ref], {
      cwd: repoDir,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
    console.log(`LaunchOS Git checked out ${ref} in ${repoDir}`);
  }

  async resetHard(repoDir: string, ref: string): Promise<void> {
    const safeRef = assertSafeGitRef(ref.replace(/^origin\//, ''), '代码版本');
    const target = ref.startsWith('origin/') ? `origin/${safeRef}` : safeRef;
    await runGit(['reset', '--hard', '--quiet', target], {
      cwd: repoDir,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    });
  }

  async fetchBranch(repoDir: string, branch: string, auth?: GitAuthContext): Promise<void> {
    const ref = assertSafeGitRef(branch, '代码版本');
    await runGit(['fetch', '--quiet', 'origin', ref], {
      cwd: repoDir,
      timeoutMs: DEFAULT_CLONE_TIMEOUT_MS,
      auth,
    });
  }

  async getRemoteHead(
    url: string,
    branch: string,
    repoDir?: string,
    auth?: GitAuthContext,
  ): Promise<RemoteCommitInfo> {
    const remote = assertSafeRemoteUrl(url);
    const ref = assertSafeGitRef(branch, '代码版本');

    if (repoDir) {
      try {
        await this.fetchBranch(repoDir, ref, auth);
        const stdout = await runGit(
          ['log', '-1', '--pretty=format:%H%x09%s', `origin/${ref}`],
          { cwd: repoDir, timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
        );
        const [sha, message] = stdout.split('\t');
        if (sha) {
          return { sha, shortSha: sha.slice(0, 7), message: message || '' };
        }
      } catch {
        // Fall through to ls-remote when the local clone is missing or stale.
      }
    }

    const stdout = await runGit(['ls-remote', remote, `refs/heads/${ref}`], {
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
      auth,
    });
    const sha = stdout.split(/\s+/)[0]?.trim();
    if (!sha) {
      throw new GitError('无法读取远程代码版本');
    }
    return { sha, shortSha: sha.slice(0, 7), message: '' };
  }

  async getCommitInfo(repoDir: string): Promise<GitCommitInfo> {
    const stdout = await runGit(
      ['log', '-1', '--pretty=format:%H%x09%s%x09%an%x09%ae%x09%cI'],
      { cwd: repoDir, timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
    );
    const [sha, message, authorName, authorEmail, committedAt] = stdout.split('\t');
    if (!sha) {
      throw new GitError('无法读取代码提交信息');
    }
    return {
      sha,
      shortSha: sha.slice(0, 7),
      message: message || '',
      authorName: authorName || '',
      authorEmail: authorEmail || '',
      committedAt: committedAt || '',
    };
  }

  async detectRepository(url: string, auth?: GitAuthContext): Promise<DetectedRepository> {
    const remote = assertSafeRemoteUrl(url);
    const parsed = parseGitRemote(remote);

    // Prefer GitHub API — git ls-remote to github.com:443 often times out from Alpha
    // the same way bare git clone does; api.github.com remains reachable with the token.
    if (auth?.token && isGitHubHttpsRemote(remote) && parsed.owner && parsed.name) {
      try {
        const defaultBranch = await detectGitHubDefaultBranchViaApi(remote, auth.token);
        return {
          url: remote,
          owner: parsed.owner,
          name: parsed.name,
          defaultBranch,
          reachable: true,
          errorMessage: null,
        };
      } catch (apiError) {
        console.warn(
          `LaunchOS Git detect via API failed, trying ls-remote: ${
            apiError instanceof Error ? apiError.message : String(apiError)
          }`,
        );
      }
    }

    try {
      const stdout = await runGit(['ls-remote', '--symref', remote, 'HEAD'], {
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        auth,
      });
      return {
        url: remote,
        owner: parsed.owner,
        name: parsed.name,
        defaultBranch: parseDefaultBranch(stdout),
        reachable: true,
        errorMessage: null,
      };
    } catch (error) {
      return {
        url: remote,
        owner: parsed.owner,
        name: parsed.name,
        defaultBranch: null,
        reachable: false,
        errorMessage: error instanceof Error ? error.message : '无法访问该代码仓库',
      };
    }
  }
}

export { isPlaceholderGitUrl };

function parseDefaultBranch(output: string): string | null {
  const match = output.match(/^ref:\s+refs\/heads\/([^\t\n]+)\tHEAD/m);
  return match?.[1]?.trim() || null;
}

async function runGit(
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    auth?: GitAuthContext;
  } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };

  const gitArgs = [...args];
  if (options.auth?.token) {
    const username = options.auth.username || 'x-access-token';
    const basic = Buffer.from(`${username}:${options.auth.token}`, 'utf8').toString('base64');
    // Prefer header auth so the token never appears in the remote URL.
    gitArgs.unshift('-c', `http.extraHeader=AUTHORIZATION: basic ${basic}`);
  }
  // GitHub HTTPS via libcurl occasionally fails HTTP/2 framing from this region;
  // force HTTP/1.1 for reliable private/public clone and ls-remote.
  gitArgs.unshift('-c', 'http.version=HTTP/1.1');

  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: options.cwd ?? process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new GitError('Git 操作超时'));
    }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if ('code' in error && error.code === 'ENOENT') {
        reject(new GitError('本机未安装 Git，无法拉取代码'));
        return;
      }
      reject(new GitError(error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new GitError(formatGitFailure(args, redactSecrets(stderr || stdout))));
    });
  });
}

function formatGitFailure(args: string[], output: string): string {
  const detail = output.trim().split('\n').filter(Boolean).at(-1);
  if (args[0] === 'clone' || args[0] === 'ls-remote') {
    return detail ? `无法拉取代码：${detail}` : '无法拉取代码';
  }
  if (args[0] === 'checkout') {
    return detail ? `无法切换代码版本：${detail}` : '无法切换代码版本';
  }
  return detail ? `Git 执行失败：${detail}` : 'Git 执行失败';
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^/@]+)@/g, '//***@');
}

function redactSecrets(value: string): string {
  return value
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:***')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '***');
}

function isGitHubHttpsRemote(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && /(^|\.)github\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function detectGitHubDefaultBranchViaApi(
  remote: string,
  token: string,
): Promise<string | null> {
  const parsed = parseGitRemote(remote);
  if (!parsed.owner || !parsed.name) {
    throw new GitError('无法解析 GitHub 仓库地址');
  }
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitError(
        `GitHub API detect HTTP ${response.status}${text ? `: ${text.slice(0, 160)}` : ''}`,
      );
    }
    const body = (await response.json()) as { default_branch?: string };
    return body.default_branch?.trim() || null;
  } catch (error) {
    if (error instanceof GitError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`GitHub API detect failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function cloneGitHubViaTarball(
  remote: string,
  directory: string,
  ref: string,
  token: string,
): Promise<void> {
  const parsed = parseGitRemote(remote);
  if (!parsed.owner || !parsed.name) {
    throw new GitError('无法解析 GitHub 仓库地址');
  }
  const safeRef = encodeURIComponent(ref === 'HEAD' ? 'HEAD' : ref);
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/tarball/${safeRef}`;
  const archivePath = join(tmpdir(), 'launchos-gh-tarballs', `${parsed.owner}-${parsed.name}-${Date.now()}.tar.gz`);
  await mkdir(dirname(archivePath), { recursive: true });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_CLONE_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'LaunchOS',
      },
    });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '');
      throw new GitError(
        `无法通过 GitHub API 拉取代码（HTTP ${response.status}）${text ? `: ${text.slice(0, 200)}` : ''}`,
      );
    }
    await pipeline(response.body as any, createWriteStream(archivePath));
  } catch (error) {
    await rm(archivePath, { force: true }).catch(() => undefined);
    if (error instanceof GitError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GitError(`无法通过 GitHub API 拉取代码：${message}`);
  } finally {
    clearTimeout(timer);
  }

  await mkdir(directory, { recursive: true });
  try {
    await runCommand('tar', ['-xzf', archivePath, '-C', directory, '--strip-components=1'], {
      timeoutMs: 120_000,
    });
    // Make directory a git repo so later checkout/getCommitInfo keep working.
    await runGit(['init', '--quiet'], { cwd: directory, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
    await runGit(['add', '-A'], { cwd: directory, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
    await runGit(
      [
        '-c',
        'user.email=launchos@local',
        '-c',
        'user.name=LaunchOS',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        `launchos-tarball ${ref}`,
      ],
      { cwd: directory, timeoutMs: DEFAULT_GIT_TIMEOUT_MS },
    );
    if (ref && ref !== 'HEAD') {
      await runGit(['branch', '-M', ref], { cwd: directory, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
    }
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
  }
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new GitError(`${command} 操作超时`));
    }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(new GitError(error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new GitError((stderr || stdout || `${command} failed`).trim().slice(0, 400)));
    });
  });
}
