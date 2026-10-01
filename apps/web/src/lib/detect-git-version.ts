import { ApiError, api } from '@/lib/api';
import type { GitDetectResult } from '@/lib/types';

export const FALLBACK_CODE_VERSIONS = ['main', 'master', 'develop', 'dev'] as const;

export const DEMO_GITHUB_URL = 'https://github.com/example/alpha-demo.git';

export type DetectedProject = {
  name: string;
  version: string;
  autoSelected: boolean;
  message: string;
  privateHint?: boolean;
};

export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (httpsMatch?.[1] && httpsMatch?.[2]) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/#?]+)$/i);
  if (sshMatch?.[1] && sshMatch?.[2]) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }
  return null;
}

export function guessProjectName(url: string): string {
  const parsed = parseGitHubRepo(url);
  if (parsed) {
    return parsed.repo;
  }
  const parts = url
    .trim()
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);
  return parts[parts.length - 1] || '我的应用';
}

export async function detectCodeVersion(url: string): Promise<DetectedProject> {
  const trimmed = url.trim();
  const fallbackName = guessProjectName(trimmed);

  try {
    const detected = await api<GitDetectResult>('/git/detect', {
      method: 'POST',
      body: JSON.stringify({ url: trimmed }),
    });
    if (!detected.defaultBranch) {
      throw new Error('暂时无法自动检测代码版本');
    }
    return {
      name: detected.name || fallbackName,
      version: detected.defaultBranch,
      autoSelected: true,
      message: detected.message || `自动检测默认分支：${detected.defaultBranch}`,
      privateHint: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '无法读取代码仓库';
    const privateHint =
      message.includes('授权') ||
      message.toLowerCase().includes('authentication') ||
      message.toLowerCase().includes('private');
    const error = new Error(message) as Error & { privateHint?: boolean };
    error.privateHint = privateHint || (err instanceof ApiError && err.status === 401);
    throw error;
  }
}
