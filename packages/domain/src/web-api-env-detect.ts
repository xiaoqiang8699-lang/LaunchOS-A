/**
 * Step 29 Phase 2 — detect actual Web browser API env key from source (no user-code mutation).
 */
export type WebApiEnvUsage = {
  actualWebApiEnvKey: string | null;
  actualWebApiEnvUsage: Array<{ file: string; pattern: string }>;
  webApiConfigMode: 'BUILD_TIME' | 'RUNTIME' | 'NONE';
  webRebuildRequired: boolean;
  plannedWebApiUrl: string;
  publicConfigOnly: true;
};

const CANDIDATES = [
  'NEXT_PUBLIC_API_URL',
  'VITE_API_URL',
  'VITE_API_BASE_URL',
  'API_BASE_URL',
] as const;

/**
 * Scan file contents for import.meta.env.X / process.env.X usage.
 */
export function detectActualWebApiEnvUsage(input: {
  files: Array<{ path: string; content: string }>;
  framework?: string | null;
  plannedWebApiUrl: string;
  requirementKeys?: string[];
}): WebApiEnvUsage {
  const usages: Array<{ file: string; pattern: string; key: string }> = [];
  for (const file of input.files) {
    const content = file.content || '';
    for (const key of CANDIDATES) {
      const patterns = [
        new RegExp(`import\\.meta\\.env\\.${key}\\b`),
        new RegExp(`process\\.env\\.${key}\\b`),
        new RegExp(`env\\.${key}\\b`),
      ];
      for (const re of patterns) {
        if (re.test(content)) {
          usages.push({ file: file.path, pattern: re.source, key });
        }
      }
    }
  }

  const usedKeys = [...new Set(usages.map((u) => u.key))];
  let actualWebApiEnvKey: string | null = usedKeys[0] || null;

  // Prefer requirement key if it matches a used key; else first used; else BUILD requirement.
  if (input.requirementKeys?.length) {
    const overlap = input.requirementKeys.find((k) => usedKeys.includes(k));
    if (overlap) actualWebApiEnvKey = overlap;
    else if (!actualWebApiEnvKey) {
      const pref = CANDIDATES.find((k) => input.requirementKeys!.includes(k));
      actualWebApiEnvKey = pref || null;
    }
  }

  const framework = String(input.framework || '').toUpperCase();
  const isBuildTimeKey =
    Boolean(actualWebApiEnvKey) &&
    (actualWebApiEnvKey!.startsWith('NEXT_PUBLIC_') ||
      actualWebApiEnvKey!.startsWith('VITE_') ||
      framework === 'VITE');

  const mode = !actualWebApiEnvKey
    ? 'NONE'
    : isBuildTimeKey
      ? 'BUILD_TIME'
      : 'RUNTIME';

  return {
    actualWebApiEnvKey,
    actualWebApiEnvUsage: usages.map((u) => ({ file: u.file, pattern: u.pattern })),
    webApiConfigMode: mode,
    webRebuildRequired: mode === 'BUILD_TIME',
    plannedWebApiUrl: input.plannedWebApiUrl,
    publicConfigOnly: true,
  };
}
