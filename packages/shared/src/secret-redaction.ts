/**
 * Redact sensitive values and KEY=value pairs from log lines.
 * @param knownSecrets plaintext secret values to scrub
 * @param knownSecretKeys config keys marked SECRET (dynamic redaction of KEY=value)
 */
export function redactSecrets(
  text: string,
  knownSecrets: string[] = [],
  knownSecretKeys: string[] = [],
): string {
  let out = text;
  for (const secret of knownSecrets) {
    const value = secret?.trim();
    if (!value || value.length < 4) {
      continue;
    }
    out = out.split(value).join('[REDACTED]');
  }

  for (const rawKey of knownSecretKeys) {
    const key = String(rawKey || '').trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const re = new RegExp(
      `\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*([^\\s"'\\\`,;]+)`,
      'gi',
    );
    out = out.replace(re, `${key}=[REDACTED]`);
  }

  out = out.replace(
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL|REDIS_URL|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*([^\s"'`,;]+)/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(
    /\b(password|authorization|accessKey|accessKeyId|accessKeySecret|secret|token|privateKey|credential)\s*[:=]\s*([^\s"'`,;]+)/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(
    /\b(DATABASE_URL|REDIS_URL|JWT_SECRET|OPENAI_API_KEY|STRIPE_SECRET_KEY|ALIYUN_ACCESS_KEY_ID|ALIYUN_ACCESS_KEY_SECRET)\s*=\s*([^\s"'`,;]+)/gi,
    '$1=[REDACTED]',
  );
  out = out.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  out = out.replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, '[REDACTED]');
  out = out.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  return out;
}
