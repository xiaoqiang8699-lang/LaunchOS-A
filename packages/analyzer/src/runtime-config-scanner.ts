export type DetectedConfigSource =
  | 'ENV_EXAMPLE'
  | 'CODE_REFERENCE'
  | 'FRAMEWORK'
  | 'MANUAL';

export type DetectedConfigConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type DetectedRuntimeConfig = {
  key: string;
  label: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  managedByLaunchOS: boolean;
  publicSafe: boolean;
  injectionPhase: DetectedConfigInjectionPhase;
  source: DetectedConfigSource;
  sourceLocation: string | null;
  defaultValue: string | null;
  confidence: DetectedConfigConfidence;
};

export type DetectedConfigInjectionPhase = 'BUILD' | 'RUNTIME' | 'BOTH';

const ENV_EXAMPLE_FILES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.local.example',
];

const SECRET_FILE_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.env.staging',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.git',
  'vendor',
  '.turbo',
  '.cache',
  'out',
  '.vercel',
]);

const SYSTEM_KEYS = new Set([
  'PORT',
  'NODE_ENV',
  'HOST',
  'HOSTNAME',
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
]);

const LABEL_MAP: Record<string, { label: string; description: string }> = {
  DATABASE_URL: {
    label: '数据库连接',
    description: '应用连接数据库所需的地址。通常由数据库服务商提供。',
  },
  REDIS_URL: {
    label: 'Redis 连接',
    description: '缓存或队列服务的连接地址。',
  },
  OPENAI_API_KEY: {
    label: 'OpenAI API 密钥',
    description: '在 OpenAI 控制台创建的 API Key。',
  },
  JWT_SECRET: {
    label: '登录安全密钥',
    description: '用于签发登录凭证的密钥，请使用足够长的随机字符串。',
  },
  AUTH_SECRET: {
    label: '登录安全密钥',
    description: '应用登录所需的安全密钥。可由 LaunchOS 自动生成随机值。',
  },
  NEXTAUTH_SECRET: {
    label: '登录安全密钥',
    description: 'NextAuth 登录所需的安全密钥。可由 LaunchOS 自动生成随机值。',
  },
  SESSION_SECRET: {
    label: '会话安全密钥',
    description: '用于保护用户会话的安全密钥。可由 LaunchOS 自动生成随机值。',
  },
  SENTRY_DSN: {
    label: 'Sentry 监控',
    description: '用于错误监控的 Sentry DSN（可使用测试占位值）。',
  },
  NEXT_PUBLIC_API_URL: {
    label: 'API 地址',
    description: '前端访问后端 API 的地址。',
  },
  NEXT_PUBLIC_SITE_NAME: {
    label: '站点名称',
    description: '展示在网站上的名称。',
  },
  STRIPE_SECRET_KEY: {
    label: 'Stripe 密钥',
    description: 'Stripe 后台提供的 Secret Key。',
  },
  STRIPE_PUBLISHABLE_KEY: {
    label: 'Stripe 公钥',
    description: 'Stripe 后台提供的 Publishable Key。',
  },
  VITE_API_URL: {
    label: 'API 地址',
    description: '前端访问后端 API 的地址。',
  },
  EXPO_PUBLIC_API_URL: {
    label: 'API 地址',
    description: '应用访问后端 API 的地址。',
  },
};

const CODE_PATTERNS: Array<{
  re: RegExp;
  source: DetectedConfigSource;
}> = [
  { re: /process\.env\.([A-Z][A-Z0-9_]*)/g, source: 'CODE_REFERENCE' },
  { re: /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g, source: 'CODE_REFERENCE' },
  { re: /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g, source: 'CODE_REFERENCE' },
  { re: /ConfigService\.get(?:<[^>]+>)?\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g, source: 'CODE_REFERENCE' },
];

export type ScanRuntimeConfigResult = {
  requirements: DetectedRuntimeConfig[];
  secretFilesDetected: string[];
};

export function isSecretEnvFileName(name: string): boolean {
  const base = name.split(/[/\\]/).pop() ?? name;
  if (SECRET_FILE_NAMES.has(base)) {
    return true;
  }
  if (base.startsWith('.env') && !ENV_EXAMPLE_FILES.includes(base)) {
    // .env.* that is not an example/template
    if (!base.includes('example') && !base.includes('sample') && !base.includes('template')) {
      return true;
    }
  }
  return false;
}

export function classifyConfigKey(key: string): {
  sensitive: boolean;
  publicSafe: boolean;
  managedByLaunchOS: boolean;
  injectionPhase: DetectedConfigInjectionPhase;
} {
  const upper = key.toUpperCase();
  const managedByLaunchOS = SYSTEM_KEYS.has(upper);
  const publicSafe =
    upper.startsWith('NEXT_PUBLIC_') ||
    upper.startsWith('VITE_') ||
    upper.startsWith('EXPO_PUBLIC_');
  const sensitive =
    !publicSafe &&
    !managedByLaunchOS &&
    (/(_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_PASS)$/i.test(upper) ||
      upper.includes('API_KEY') ||
      upper === 'DATABASE_URL' ||
      upper === 'REDIS_URL' ||
      (upper.endsWith('_URL') && /DATABASE|REDIS|MONGO|POSTGRES|MYSQL/i.test(upper)));

  let injectionPhase: DetectedConfigInjectionPhase = 'RUNTIME';
  if (publicSafe) {
    // Frontend public env is baked at build time.
    injectionPhase = 'BUILD';
  } else if (sensitive) {
    // Secrets must never enter frontend/build bundles by default.
    injectionPhase = 'RUNTIME';
  } else if (managedByLaunchOS) {
    injectionPhase = 'RUNTIME';
  } else {
    // Uncertain → prefer RUNTIME (safer).
    injectionPhase = 'RUNTIME';
  }

  return { sensitive, publicSafe, managedByLaunchOS, injectionPhase };
}

export function labelForConfigKey(key: string): { label: string; description: string } {
  const mapped = LABEL_MAP[key];
  if (mapped) {
    return mapped;
  }
  return {
    label: key,
    description: `运行所需配置：${key}`,
  };
}

export function parseEnvExampleContent(
  content: string,
  sourceLocation: string,
): Array<{
  key: string;
  defaultValue: string | null;
  hasDefault: boolean;
  sourceLocation: string;
}> {
  const out: Array<{
    key: string;
    defaultValue: string | null;
    hasDefault: boolean;
    sourceLocation: string;
  }> = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    let raw = match[2] ?? '';
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    const value = raw.trim();
    const hasDefault = value.length > 0;
    out.push({
      key,
      defaultValue: hasDefault ? value : null,
      hasDefault,
      sourceLocation,
    });
  }
  return out;
}

function hasFallbackInSnippet(snippet: string, key: string): boolean {
  // process.env.KEY || 'x'  /  ??  /  | 3000
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`process\\.env\\.${escaped}\\s*(\\?\\?|\\|\\|)`),
    new RegExp(`process\\.env\\[['"]${escaped}['"]\\]\\s*(\\?\\?|\\|\\|)`),
    new RegExp(`import\\.meta\\.env\\.${escaped}\\s*(\\?\\?|\\|\\|)`),
  ];
  return patterns.some((re) => re.test(snippet));
}

/**
 * Scan a unit directory for runtime config requirements.
 * Never reads values from real .env / .env.local / etc.
 */
export async function scanUnitRuntimeConfig(
  unitRoot: string,
  options?: { readFile?: (path: string) => Promise<string>; listFiles?: (dir: string) => Promise<string[]> },
): Promise<ScanRuntimeConfigResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const readFile =
    options?.readFile ??
    (async (filePath: string) => fs.readFile(filePath, 'utf8'));
  const listFiles =
    options?.listFiles ??
    (async (dir: string) => {
      const results: string[] = [];
      async function walk(current: string): Promise<void> {
        let entries;
        try {
          entries = await fs.readdir(current, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.') && entry.name !== '.' && !entry.name.startsWith('.env')) {
            // allow .env* ; skip other dotdirs like .git already in SKIP
          }
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) {
              continue;
            }
            await walk(full);
            continue;
          }
          results.push(full);
        }
      }
      await walk(dir);
      return results;
    });

  const byKey = new Map<string, DetectedRuntimeConfig>();
  const secretFilesDetected: string[] = [];

  const allFiles = await listFiles(unitRoot);
  for (const filePath of allFiles) {
    const base = path.basename(filePath);
    const rel = path.relative(unitRoot, filePath).replace(/\\/g, '/');

    if (isSecretEnvFileName(base)) {
      secretFilesDetected.push(rel);
      continue;
    }

    if (ENV_EXAMPLE_FILES.includes(base)) {
      let content = '';
      try {
        content = await readFile(filePath);
      } catch {
        continue;
      }
      for (const item of parseEnvExampleContent(content, rel)) {
        upsertDetected(byKey, {
          key: item.key,
          source: 'ENV_EXAMPLE',
          sourceLocation: item.sourceLocation,
          defaultValue: item.defaultValue,
          required: !item.hasDefault,
          confidence: 'HIGH',
          fromExample: true,
        });
      }
      continue;
    }

    if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(base)) {
      continue;
    }
    let content = '';
    try {
      content = await readFile(filePath);
    } catch {
      continue;
    }
    for (const { re, source } of CODE_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        const key = match[1]!;
        const start = Math.max(0, match.index - 20);
        const end = Math.min(content.length, match.index + match[0].length + 40);
        const snippet = content.slice(start, end);
        const fallback = hasFallbackInSnippet(snippet, key);
        upsertDetected(byKey, {
          key,
          source,
          sourceLocation: rel,
          defaultValue: null,
          required: !fallback,
          confidence: fallback ? 'MEDIUM' : 'HIGH',
          fromExample: false,
        });
      }
    }
  }

  return {
    requirements: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    secretFilesDetected,
  };
}

function upsertDetected(
  map: Map<string, DetectedRuntimeConfig>,
  input: {
    key: string;
    source: DetectedConfigSource;
    sourceLocation: string | null;
    defaultValue: string | null;
    required: boolean;
    confidence: DetectedConfigConfidence;
    fromExample: boolean;
  },
): void {
  const classification = classifyConfigKey(input.key);
  const labels = labelForConfigKey(input.key);
  const existing = map.get(input.key);

  let required = input.required;
  let confidence = input.confidence;
  let defaultValue = input.defaultValue;
  let source = input.source;
  let sourceLocation = input.sourceLocation;

  if (classification.managedByLaunchOS) {
    required = false;
    confidence = 'HIGH';
  } else if (input.fromExample && input.defaultValue) {
    required = false;
  }

  if (existing) {
    // Prefer ENV_EXAMPLE metadata; escalate required if either source says required without default
    if (existing.source === 'ENV_EXAMPLE' && source !== 'ENV_EXAMPLE') {
      source = existing.source;
      sourceLocation = existing.sourceLocation;
      defaultValue = existing.defaultValue ?? defaultValue;
    }
    if (source === 'ENV_EXAMPLE' && existing.source !== 'ENV_EXAMPLE') {
      // keep new example source
    }
    required = (existing.required || required) && !classification.managedByLaunchOS;
    if (existing.defaultValue && !defaultValue) {
      defaultValue = existing.defaultValue;
      if (existing.source === 'ENV_EXAMPLE') {
        required = false;
      }
    }
    confidence =
      confidenceRank(confidence) >= confidenceRank(existing.confidence)
        ? confidence
        : existing.confidence;
    if (existing.source === 'ENV_EXAMPLE') {
      source = 'ENV_EXAMPLE';
      sourceLocation = existing.sourceLocation;
    }
  }

  // Unknown optional code refs: don't force required aggressively if LOW
  if (!input.fromExample && !required) {
    confidence = confidence === 'HIGH' ? 'MEDIUM' : confidence;
  }
  if (!classification.managedByLaunchOS && !input.fromExample && required && !existing) {
    // code-only without fallback → required but if we can't confirm, keep HIGH from no-fallback
  }

  map.set(input.key, {
    key: input.key,
    label: labels.label,
    description: labels.description,
    required,
    sensitive: classification.sensitive,
    managedByLaunchOS: classification.managedByLaunchOS,
    publicSafe: classification.publicSafe,
    injectionPhase: classification.injectionPhase,
    source,
    sourceLocation,
    defaultValue,
    confidence: classification.managedByLaunchOS ? 'HIGH' : confidence,
  });
}

function confidenceRank(value: DetectedConfigConfidence): number {
  if (value === 'HIGH') return 3;
  if (value === 'MEDIUM') return 2;
  return 1;
}

/** Artifact / pack exclusion patterns for real secret env files. */
export const SECRET_ENV_ARTIFACT_EXCLUDES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.env.staging',
  '.env*.local',
];
