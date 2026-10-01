import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredential,
} from '@launchos/shared';

export { decryptCredential, encryptCredential, isEncryptedCredential };

export type ProviderSecrets = {
  accessKey: string;
  secretKey: string;
};

export function encryptProviderSecrets(secrets: ProviderSecrets): string {
  const accessKey = secrets.accessKey.trim();
  const secretKey = secrets.secretKey.trim();
  if (!accessKey || !secretKey) {
    throw new Error('accessKey and secretKey are required');
  }
  return encryptCredential(JSON.stringify({ accessKey, secretKey }));
}

export function decryptProviderSecrets(payload: string): ProviderSecrets {
  const raw = decryptCredential(payload);
  try {
    const parsed = JSON.parse(raw) as { accessKey?: unknown; secretKey?: unknown };
    if (typeof parsed.accessKey === 'string' && typeof parsed.secretKey === 'string') {
      const accessKey = parsed.accessKey.trim();
      const secretKey = parsed.secretKey.trim();
      if (accessKey && secretKey) {
        return { accessKey, secretKey };
      }
    }
  } catch {
    // Legacy mock credentials were stored as a single encrypted string.
  }
  throw new Error('Encrypted credential is missing accessKey or secretKey');
}
