import { GitError } from './errors';

const UNSAFE = /[\r\n\0]/;

export function assertSafeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('-') || UNSAFE.test(trimmed)) {
    throw new GitError('代码地址无效');
  }
  if (!/^(https?:\/\/|git@)/i.test(trimmed)) {
    throw new GitError('只支持 Git HTTP(S) 或 SSH 地址');
  }
  return trimmed;
}

export function assertSafeGitRef(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('-') || UNSAFE.test(trimmed) || trimmed.includes('..')) {
    throw new GitError(`${label}无效`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(trimmed)) {
    throw new GitError(`${label}无效`);
  }
  return trimmed;
}

export function parseGitRemote(url: string): { owner: string | null; name: string } {
  const trimmed = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/#?]+)/i);
  if (httpsMatch?.[1] && httpsMatch[2]) {
    return { owner: httpsMatch[1], name: httpsMatch[2] };
  }
  const sshMatch = trimmed.match(/^git@[^:]+:([^/]+)\/([^/#?]+)$/i);
  if (sshMatch?.[1] && sshMatch[2]) {
    return { owner: sshMatch[1], name: sshMatch[2] };
  }
  const parts = trimmed.split('/').filter(Boolean);
  return { owner: null, name: parts[parts.length - 1] || 'repository' };
}

export function isPlaceholderGitUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  return value.includes('github.com/example/') || value.includes('example/alpha-demo');
}
