type DohAnswer = { data?: string; type?: number };

/**
 * Resolve TXT via DoH (avoids local Fake-IP DNS hijacks).
 */
export async function resolveTxtPublic(hostname: string): Promise<string[]> {
  const endpoints = [
    `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=TXT`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=TXT`,
  ];
  const values: string[] = [];
  let lastError: unknown;
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`DoH HTTP ${response.status}`);
      }
      const json = (await response.json()) as { Answer?: DohAnswer[]; Status?: number };
      for (const ans of json.Answer ?? []) {
        if (ans.type === 16 && typeof ans.data === 'string') {
          values.push(ans.data.replace(/^"|"$/g, '').replace(/" "/g, ''));
        }
      }
      if (values.length > 0) {
        return [...new Set(values)];
      }
      if (json.Status !== 0 && json.Status !== undefined) {
        throw new Error(`DoH status ${json.Status}`);
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (values.length > 0) {
    return [...new Set(values)];
  }
  throw lastError instanceof Error ? lastError : new Error('TXT resolve failed');
}

export async function verifyTxtContains(
  hostname: string,
  expectedValue: string,
): Promise<{ ok: boolean; values: string[]; error?: string }> {
  try {
    const values = await resolveTxtPublic(hostname);
    return {
      ok: values.some((item) => item.includes(expectedValue)),
      values,
    };
  } catch (error) {
    return {
      ok: false,
      values: [],
      error: error instanceof Error ? error.message : 'TXT resolve failed',
    };
  }
}

export async function waitForTxtPropagation(options: {
  hostname: string;
  expectedValue: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<{ ok: boolean; values: string[]; timedOut: boolean }> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const intervalMs = options.intervalMs ?? 5_000;
  const started = Date.now();
  let lastValues: string[] = [];
  while (Date.now() - started < timeoutMs) {
    const result = await verifyTxtContains(options.hostname, options.expectedValue);
    lastValues = result.values;
    if (result.ok) {
      return { ok: true, values: result.values, timedOut: false };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { ok: false, values: lastValues, timedOut: true };
}
