import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunner } from '@launchos/remote-runner';
import { GATEWAY_LAYOUT } from './gateway-runtime';
import {
  extractGatewayServerNames,
  generateGatewayConfig,
  upsertGatewayRouteConfig,
} from './gateway-access';

const WILDCARD_CERT = '/www/server/panel/vhost/cert/launchos-wildcard-zsaos/fullchain.pem';

function extractInstalledCertificate(config: string): { fullchain: string; privkey: string } | null {
  const fullchain = config.match(/ssl_certificate\s+([^;]+);/)?.[1]?.trim();
  const privkey = config.match(/ssl_certificate_key\s+([^;]+);/)?.[1]?.trim();
  if (!fullchain || !privkey) return null;
  if (fullchain.includes('\n') || privkey.includes('\n')) return null;
  return { fullchain, privkey };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function applyColocatedNginxRoute(input: {
  host: string;
  port: number;
  username: string;
  password: string;
  hostname: string;
  targetPort: number;
  healthPath?: string;
}): Promise<{ hostname: string; reloaded: boolean; certificatePresent: boolean }> {
  const runner = new RemoteRunner();
  const dir = await mkdtemp(join(tmpdir(), 'launchos-nginx-route-'));
  try {
    await runner.connect({
      host: input.host,
      port: input.port,
      username: input.username,
      password: input.password,
      readyTimeoutMs: 20_000,
    });
    const current = await runner.execute(
      `cat ${GATEWAY_LAYOUT.includeConf} 2>/dev/null || true`,
      { timeoutMs: 20_000 },
    );
    const certificates = extractInstalledCertificate(current.stdout);
    const generated = generateGatewayConfig({
      hostname: input.hostname,
      targetHost: '127.0.0.1',
      targetPort: input.targetPort,
      healthPath: input.healthPath || '/',
      certificateFullchainPath: certificates?.fullchain,
      certificatePrivkeyPath: certificates?.privkey,
    });
    const next = upsertGatewayRouteConfig(current.stdout, generated.combined);
    const previousNames = extractGatewayServerNames(current.stdout);
    const nextNames = new Set(extractGatewayServerNames(next));
    const replaced = new Set(extractGatewayServerNames(generated.combined));
    for (const name of previousNames) {
      if (!replaced.has(name) && !nextNames.has(name)) {
        throw new Error(`GATEWAY_ROUTE_REGRESSION ${name}`);
      }
    }
    const local = join(dir, 'launchos-routes.conf');
    await writeFile(local, next, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const temp = `${GATEWAY_LAYOUT.generated}/routes-${stamp}.conf`;
    const active = GATEWAY_LAYOUT.includeConf;
    const backup = `${GATEWAY_LAYOUT.backups}/routes-${stamp}.conf`;
    await runner.execute(
      `mkdir -p ${GATEWAY_LAYOUT.generated} ${GATEWAY_LAYOUT.active} ${GATEWAY_LAYOUT.backups}`,
      { timeoutMs: 15_000 },
    );
    await runner.upload(local, temp, { timeoutMs: 60_000 });
    const applied = await runner.execute(
      [
        'set -e',
        `if [ -f ${active} ]; then cp -f ${active} ${backup}; fi`,
        `cp -f ${temp} ${active}`,
        `if ! nginx -t; then if [ -f ${backup} ]; then cp -f ${backup} ${active}; fi; exit 1; fi`,
        'nginx -s reload',
        `if [ -f ${shellQuote(certificates?.fullchain || WILDCARD_CERT)} ]; then echo CERT=1; else echo CERT=0; fi`,
      ].join('\n'),
      { timeoutMs: 30_000 },
    );
    if (applied.exitCode !== 0) {
      const detail = (applied.stderr || applied.stdout || 'nginx -t failed').trim();
      throw new Error(detail.slice(0, 500));
    }
    return {
      hostname: input.hostname.trim().toLowerCase(),
      reloaded: true,
      certificatePresent: applied.stdout.includes('CERT=1'),
    };
  } finally {
    await runner.disconnect().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
