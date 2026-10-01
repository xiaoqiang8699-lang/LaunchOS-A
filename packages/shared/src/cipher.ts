import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1';

export function encryptCredential(plaintext: string): string {
  const value = plaintext.trim();
  if (!value) {
    throw new Error('Credential must not be empty');
  }
  if (isEncryptedCredential(value)) {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptCredential(payload: string): string {
  if (!isEncryptedCredential(payload)) {
    throw new Error('Credential is not encrypted');
  }

  const parts = payload.split(':');
  const iv = parts[2];
  const tag = parts[3];
  const data = parts[4];
  if (!iv || !tag || !data) {
    throw new Error('Invalid encrypted credential');
  }

  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function isEncryptedCredential(value: string): boolean {
  return value.startsWith(`${PREFIX}:`);
}

function deriveKey(): Buffer {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return createHash('sha256').update(`launchos-credential:${secret}`).digest();
}
