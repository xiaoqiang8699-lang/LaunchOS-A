import { mkdir, readFile, writeFile, rm, copyFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { unzipSync, strFromU8 } from 'fflate';
import {
  assertExtractBudget,
  assertZipSizeWithinLimit,
  deriveAppNameFromZip,
  isBlockedZipEntry,
  sanitizeZipEntryPath,
} from '@launchos/shared';

export type ExtractedZipProject = {
  appName: string;
  extractRoot: string;
  fileCount: number;
  extractedBytes: number;
};

export async function extractOnboardingZip(input: {
  projectId: string;
  zipBuffer?: Buffer;
  zipPath?: string;
  originalName?: string;
  workspaceDir: string;
}): Promise<ExtractedZipProject> {
  const zipBuffer =
    input.zipBuffer ??
    (input.zipPath ? await readFile(input.zipPath) : null);
  if (!zipBuffer?.byteLength) {
    throw new Error('ZIP_EMPTY');
  }
  assertZipSizeWithinLimit(zipBuffer.byteLength);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch {
    throw new Error('ZIP_INVALID');
  }

  await rm(input.workspaceDir, { recursive: true, force: true });
  await mkdir(input.workspaceDir, { recursive: true });

  let fileCount = 0;
  let extractedBytes = 0;
  let packageName: string | null = null;
  const writtenRoots = new Set<string>();

  for (const [rawName, data] of Object.entries(entries)) {
    if (rawName.endsWith('/')) continue;
    const safe = sanitizeZipEntryPath(rawName);
    if (!safe) continue;
    if (isBlockedZipEntry(safe)) continue;

    fileCount += 1;
    extractedBytes += data.byteLength;
    assertExtractBudget({ fileCount, extractedBytes });

    const target = resolve(input.workspaceDir, safe);
    if (!target.startsWith(resolve(input.workspaceDir))) {
      throw new Error('ZIP_SLIP');
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    writtenRoots.add(safe.split('/')[0] || '');
    if (safe === 'package.json' || safe.endsWith('/package.json')) {
      try {
        const parsed = JSON.parse(strFromU8(data)) as { name?: string };
        if (parsed.name?.trim()) packageName = parsed.name.trim();
      } catch {
        // ignore invalid package.json
      }
    }
  }

  if (fileCount === 0) {
    throw new Error('ZIP_EMPTY_CONTENT');
  }

  const rootDirName =
    writtenRoots.size === 1 ? [...writtenRoots][0] || null : null;

  return {
    appName: deriveAppNameFromZip({
      fileName: input.originalName,
      packageName,
      rootDirName,
    }),
    extractRoot: input.workspaceDir,
    fileCount,
    extractedBytes,
  };
}

export function onboardingZipTempPath(uploadId: string): string {
  const root = process.env.LAUNCHOS_UPLOAD_ROOT?.trim() || join(tmpdir(), 'launchos-uploads');
  return join(root, `${uploadId}.zip`);
}

export async function persistZipUpload(uploadId: string, zipBuffer: Buffer): Promise<string> {
  const path = onboardingZipTempPath(uploadId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, zipBuffer);
  await markSourceArchiveCleanupEligible(path, {
    reason: 'TEMPORARY_SOURCE_ARCHIVE',
    hours: 24,
  });
  return path;
}

export async function persistZipUploadFromPath(
  uploadId: string,
  sourcePath: string,
): Promise<string> {
  const path = onboardingZipTempPath(uploadId);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(sourcePath, path);
  await markSourceArchiveCleanupEligible(path, {
    reason: 'TEMPORARY_SOURCE_ARCHIVE',
    hours: 24,
  });
  return path;
}

/** Mark temp ZIP for deferred cleanup (no immediate delete of user data). */
export async function markSourceArchiveCleanupEligible(
  archivePath: string,
  opts?: { reason?: string; hours?: number },
): Promise<void> {
  const hours = opts?.hours ?? 24;
  const metaPath = `${archivePath}.cleanup.json`;
  const eligibleAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  await writeFile(
    metaPath,
    JSON.stringify({
      eligible: true,
      reason: opts?.reason || 'TEMPORARY_SOURCE_ARCHIVE',
      eligibleAt,
      createdAt: new Date().toISOString(),
    }),
    'utf8',
  );
}

export async function cleanupTempUpload(path?: string | null): Promise<void> {
  if (!path) return;
  await unlink(path).catch(() => undefined);
  await unlink(`${path}.cleanup.json`).catch(() => undefined);
}

export async function readPersistedZip(path: string): Promise<Buffer> {
  return readFile(path);
}
