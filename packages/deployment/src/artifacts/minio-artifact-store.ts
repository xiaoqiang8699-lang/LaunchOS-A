import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Client } from 'minio';

export type UploadResult = {
  bucket: string;
  objectName: string;
  size: number;
};

export class ArtifactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStoreError';
  }
}

/**
 * Artifact store with two backends:
 * - MinIO / S3 (default) when MINIO_ENDPOINT is an http(s) URL
 * - Local filesystem when ARTIFACT_STORE=local or MINIO_ENDPOINT=local|file
 *
 * Local mode is for External Alpha colocated worker+runtime on PLATFORM_MANAGED
 * nodes where pulling MinIO is unavailable. storagePath stays bucket/object.
 */
export class MinioArtifactStore {
  async upload(objectName: string, filePath: string): Promise<UploadResult> {
    const bucket = process.env.MINIO_BUCKET?.trim() || 'launchos-artifacts';
    if (useLocalArtifactStore()) {
      const dest = localObjectPath(bucket, objectName);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(filePath, dest);
      const info = await stat(dest);
      console.log(`LaunchOS Artifact stored local://${dest} (${info.size} bytes)`);
      return { bucket, objectName, size: info.size };
    }

    const client = createMinioClient();
    const exists = await client.bucketExists(bucket);
    if (!exists) {
      await client.makeBucket(bucket);
    }

    await client.fPutObject(bucket, objectName, filePath);
    const objectStat = await client.statObject(bucket, objectName);
    console.log(`LaunchOS Artifact uploaded s3://${bucket}/${objectName} (${objectStat.size} bytes)`);
    return {
      bucket,
      objectName,
      size: objectStat.size,
    };
  }

  async download(storagePath: string, destFile: string): Promise<void> {
    const { bucket, objectName } = parseStoragePath(storagePath);
    await mkdir(dirname(destFile), { recursive: true });

    if (useLocalArtifactStore() || isLocalStoragePath(storagePath)) {
      const source = localObjectPath(bucket, objectName);
      await copyFile(source, destFile);
      console.log(`LaunchOS Artifact loaded local://${source} -> ${destFile}`);
      return;
    }

    const client = createMinioClient();
    await client.fGetObject(bucket, objectName, destFile);
    console.log(`LaunchOS Artifact downloaded s3://${bucket}/${objectName} -> ${destFile}`);
  }
}

function useLocalArtifactStore(): boolean {
  const mode = (process.env.ARTIFACT_STORE || '').trim().toLowerCase();
  if (mode === 'local' || mode === 'filesystem' || mode === 'file') {
    return true;
  }
  const endpoint = (process.env.MINIO_ENDPOINT || '').trim().toLowerCase();
  return endpoint === 'local' || endpoint === 'file' || endpoint.startsWith('file:');
}

function isLocalStoragePath(storagePath: string): boolean {
  return storagePath.startsWith('local://') || storagePath.startsWith('file://');
}

function localArtifactRoot(): string {
  return (
    process.env.LOCAL_ARTIFACT_ROOT?.trim() ||
    process.env.ARTIFACT_LOCAL_ROOT?.trim() ||
    '/opt/launchos/artifacts'
  );
}

function localObjectPath(bucket: string, objectName: string): string {
  return join(localArtifactRoot(), bucket, objectName);
}

function parseStoragePath(storagePath: string): { bucket: string; objectName: string } {
  const trimmed = storagePath
    .replace(/^s3:\/\//, '')
    .replace(/^local:\/\//, '')
    .replace(/^file:\/\//, '')
    .replace(/^\/+/, '');
  const defaultBucket = process.env.MINIO_BUCKET?.trim() || 'launchos-artifacts';
  const slash = trimmed.indexOf('/');
  if (slash <= 0) {
    return { bucket: defaultBucket, objectName: trimmed };
  }
  return {
    bucket: trimmed.slice(0, slash),
    objectName: trimmed.slice(slash + 1),
  };
}

function createMinioClient(): Client {
  const raw = process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000';
  const parsed = new URL(raw);
  const accessKey = process.env.MINIO_ACCESS_KEY?.trim();
  const secretKey = process.env.MINIO_SECRET_KEY?.trim();

  if (!accessKey || !secretKey) {
    throw new ArtifactStoreError('MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set');
  }

  return new Client({
    endPoint: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
    useSSL: parsed.protocol === 'https:',
    accessKey,
    secretKey,
  });
}
