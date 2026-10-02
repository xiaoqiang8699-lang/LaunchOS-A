/**
 * Sanitize business metadata before any AI prompt / insight generation.
 * Never include passwords, secrets, tokens, keys, or DATABASE_URL.
 */
const BLOCKED_KEY =
  /password|passwd|secret|token|credential|authorization|private.?key|api.?key|database_url|access.?key|refresh.?key|bearer/i;

export function sanitizeAiMetadata(input: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    if (BLOCKED_KEY.test(key)) continue;
    if (value == null) {
      out[key] = null;
      continue;
    }
    if (typeof value === 'string') {
      if (looksLikeSecret(value)) continue;
      out[key] = value.slice(0, 240);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

export function looksLikeSecret(value: string): boolean {
  if (/postgres(ql)?:\/\//i.test(value)) return true;
  if (/mongodb(\+srv)?:\/\//i.test(value)) return true;
  if (/BEGIN (RSA |OPENSSH )?PRIVATE KEY/i.test(value)) return true;
  if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(value)) return true;
  if (/sk-[A-Za-z0-9]{20,}/.test(value)) return true;
  return false;
}

export function redactText(input: string): string {
  return String(input || '')
    .replace(/postgres(ql)?:\/\/\S+/gi, '[redacted-db]')
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '[redacted-db]')
    .replace(/sk-[A-Za-z0-9]{20,}/g, '[redacted-key]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]')
    .slice(0, 2000);
}

export function categorizeFailure(code: string | null | undefined, message: string | null | undefined): string {
  const raw = `${code || ''} ${message || ''}`.toLowerCase();
  if (/env|environment|missing.?var|config/.test(raw)) return '环境变量缺失/配置问题';
  if (/docker|build|image|dockerfile|npm err|pnpm|yarn/.test(raw)) return 'Docker/构建失败';
  if (/dns|domain|certificate|tls|ssl|nginx/.test(raw)) return '域名/证书问题';
  if (/timeout|network|econn|unreachable/.test(raw)) return '网络/超时';
  if (/quota|limit|capacity|resource/.test(raw)) return '配额/容量限制';
  if (/git|clone|repository|source/.test(raw)) return '源码拉取失败';
  if (/health|probe|start.?fail|crash/.test(raw)) return '启动/健康检查失败';
  return '其他失败';
}
