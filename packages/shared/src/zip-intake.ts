/**
 * Safe local ZIP intake helpers for onboarding (Zip Slip, limits, ignore noise).
 */
import { posix } from 'node:path';

export const ZIP_INTAKE_LIMITS = {
  maxZipBytes: 80 * 1024 * 1024,
  maxExtractedBytes: 250 * 1024 * 1024,
  maxFileCount: 8_000,
  maxEntryNameLength: 512,
} as const;

export const ZIP_IGNORED_PATH_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  'caches',
  '__pycache__',
  '.venv',
  'venv',
]);

export const ZIP_BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
  '.msi',
  '.dmg',
]);

export function sanitizeZipEntryPath(raw: string): string | null {
  const normalized = String(raw || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim();
  if (!normalized || normalized.length > ZIP_INTAKE_LIMITS.maxEntryNameLength) return null;
  if (normalized.startsWith('/') || normalized.includes('\0')) return null;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) return null;
  if (parts.some((part) => ZIP_IGNORED_PATH_SEGMENTS.has(part.toLowerCase()))) return null;
  return parts.join('/');
}

export function isBlockedZipEntry(path: string): boolean {
  const base = posix.basename(path).toLowerCase();
  const ext = base.includes('.') ? `.${base.split('.').pop()}` : '';
  return ZIP_BLOCKED_EXTENSIONS.has(ext);
}

export function assertZipSizeWithinLimit(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('ZIP_EMPTY');
  }
  if (bytes > ZIP_INTAKE_LIMITS.maxZipBytes) {
    throw new Error('ZIP_TOO_LARGE');
  }
}

export function assertExtractBudget(input: {
  fileCount: number;
  extractedBytes: number;
}): void {
  if (input.fileCount > ZIP_INTAKE_LIMITS.maxFileCount) {
    throw new Error('ZIP_TOO_MANY_FILES');
  }
  if (input.extractedBytes > ZIP_INTAKE_LIMITS.maxExtractedBytes) {
    throw new Error('ZIP_EXTRACTED_TOO_LARGE');
  }
}

export function deriveAppNameFromZip(input: {
  fileName?: string | null;
  packageName?: string | null;
  rootDirName?: string | null;
}): string {
  const fromPackage = input.packageName?.trim();
  if (fromPackage) return fromPackage.slice(0, 80);
  const fromRoot = input.rootDirName?.trim();
  if (fromRoot && fromRoot !== '.' && fromRoot !== '/') return fromRoot.slice(0, 80);
  const base = String(input.fileName || 'my-app')
    .replace(/\.zip$/i, '')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (base || 'my-app').slice(0, 80);
}

export function sanitizeInternalReturnTo(
  value: string | null | undefined,
  fallback = '/onboarding/source',
): string {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('://')) {
    return fallback;
  }
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) {
    return fallback;
  }
  return raw.slice(0, 200) || fallback;
}

export function githubConnectSuccessUrl(webOrigin: string, returnTo: string): string {
  const base = webOrigin.replace(/\/$/, '');
  const path = sanitizeInternalReturnTo(returnTo);
  const joiner = path.includes('?') ? '&' : '?';
  return `${base}${path}${joiner}github=connected`;
}

export function githubConnectErrorUrl(
  webOrigin: string,
  returnTo: string | null | undefined,
  reason: string,
): string {
  const base = webOrigin.replace(/\/$/, '');
  const path = sanitizeInternalReturnTo(returnTo, '/onboarding/source');
  const joiner = path.includes('?') ? '&' : '?';
  return `${base}${path}${joiner}github=error&reason=${encodeURIComponent(reason.slice(0, 64))}`;
}
