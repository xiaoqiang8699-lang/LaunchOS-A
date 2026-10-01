import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MinioArtifactStore } from '../../../packages/deployment/src/artifacts/minio-artifact-store.ts';

const require = createRequire(resolve(process.cwd(), '../../packages/deployment/package.json'));
const { Client } = require('minio');
const { config } = createRequire(resolve(process.cwd(), '../worker/package.json'))('dotenv');

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '../../.env') });

const source = resolve(process.cwd(), '../../fixtures/real-deploy-test-app/server.js');
const body = await readFile(source);
if (body.length === 0) {
  throw new Error('ARTIFACT_EMPTY');
}
const before = createHash('sha256').update(body).digest('hex');
const dir = await mkdtemp(join(tmpdir(), 'launchos-artifact-'));
const packed = join(dir, 'server.js');
await writeFile(packed, body);
const objectName = `dry-run/real-deploy-test-app-${Date.now()}.js`;
const store = new MinioArtifactStore();
const uploaded = await store.upload(objectName, packed);
if (!uploaded.size) {
  throw new Error('ARTIFACT_UPLOAD_EMPTY');
}
const downloaded = join(dir, 'downloaded.js');
await store.download(`${uploaded.bucket}/${uploaded.objectName}`, downloaded);
const afterBody = await readFile(downloaded);
const after = createHash('sha256').update(afterBody).digest('hex');
if (before !== after || afterBody.length === 0) {
  throw new Error('ARTIFACT_INTEGRITY_MISMATCH');
}

const endpoint = new URL(process.env.MINIO_ENDPOINT?.trim() || 'http://127.0.0.1:9000');
const client = new Client({
  endPoint: endpoint.hostname,
  port: Number(endpoint.port || 80),
  useSSL: endpoint.protocol === 'https:',
  accessKey: process.env.MINIO_ACCESS_KEY,
  secretKey: process.env.MINIO_SECRET_KEY,
});
await client.removeObject(uploaded.bucket, uploaded.objectName);
await rm(dir, { recursive: true, force: true });
console.log(JSON.stringify({
  bytes: afterBody.length,
  integrity: 'MATCH',
  endpointHost: endpoint.hostname,
  public: endpoint.hostname !== '127.0.0.1' && endpoint.hostname !== 'localhost',
}));
