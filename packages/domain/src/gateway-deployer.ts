import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunner, RemoteRunnerError } from '@launchos/remote-runner';
import type { GatewayRouteTable } from './gateway-routes';

const REMOTE_ROOT = '/opt/launchos-gateway';
const REMOTE_ROUTES = `${REMOTE_ROOT}/routes.json`;
const REMOTE_ENV = `${REMOTE_ROOT}/.env`;

/** Loopback-only Gateway behind host nginx (BT). Not public. */
export const GATEWAY_LOOPBACK_PORT = 9080;
export const GATEWAY_LOOPBACK_HOST = '127.0.0.1';

const BT_VHOST_DIR = '/www/server/panel/vhost/nginx';
const BT_NGINX_BIN = '/www/server/nginx/sbin/nginx';

export type GatewayDeployTarget = {
  host: string;
  port?: number;
  username: string;
  password: string;
};

export type GatewayDeployResult = {
  host: string;
  publicPort: number;
  listen: string;
  healthUrl: string;
  routesPath: string;
};

/**
 * Deploy LaunchOS Gateway on loopback :9080 (routes-file mode).
 * Public entry remains host nginx :80 → proxy to this Gateway.
 */
export class GatewayRemoteDeployer {
  async deploy(target: GatewayDeployTarget, gatewayBundleDir: string): Promise<GatewayDeployResult> {
    const runner = new RemoteRunner();
    try {
      await runner.connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        readyTimeoutMs: 25_000,
      });

      await this.run(
        runner,
        [
          'set -eux',
          `mkdir -p ${REMOTE_ROOT}/dist`,
          'command -v node >/dev/null 2>&1 || (curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && yum install -y nodejs) || true',
          'command -v node >/dev/null 2>&1 || (apt-get update -y && apt-get install -y nodejs npm) || true',
          'node -v',
        ].join('\n'),
        10 * 60 * 1000,
      );

      await runner.upload(join(gatewayBundleDir, 'gateway.cjs'), `${REMOTE_ROOT}/gateway.cjs`, {
        timeoutMs: 10 * 60 * 1000,
      });

      const envBody = [
        `GATEWAY_HTTP_PORT=${GATEWAY_LOOPBACK_PORT}`,
        `GATEWAY_BIND_HOST=${GATEWAY_LOOPBACK_HOST}`,
        `GATEWAY_ROUTES_FILE=${REMOTE_ROUTES}`,
        'NODE_ENV=production',
        '',
      ].join('\n');
      const localEnv = join(gatewayBundleDir, '.env.remote');
      await writeFile(localEnv, envBody, 'utf8');
      await runner.upload(localEnv, REMOTE_ENV, { timeoutMs: 60_000 });

      const emptyRoutes = JSON.stringify(
        { updatedAt: new Date().toISOString(), rootDomain: '', routes: {} },
        null,
        2,
      );
      const localRoutes = join(gatewayBundleDir, 'routes.json');
      await writeFile(localRoutes, emptyRoutes, 'utf8');
      await runner.upload(localRoutes, REMOTE_ROUTES, { timeoutMs: 60_000 });

      const unit = [
        '[Unit]',
        'Description=LaunchOS Gateway',
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `WorkingDirectory=${REMOTE_ROOT}`,
        `EnvironmentFile=${REMOTE_ENV}`,
        `ExecStart=/usr/bin/node ${REMOTE_ROOT}/gateway.cjs`,
        'Restart=always',
        'RestartSec=3',
        'User=root',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n');
      const localUnit = join(gatewayBundleDir, 'launchos-gateway.service');
      await writeFile(localUnit, unit, 'utf8');
      await runner.upload(localUnit, '/etc/systemd/system/launchos-gateway.service', {
        timeoutMs: 60_000,
      });

      await this.run(
        runner,
        [
          'set -eux',
          // Never stop/kill host nginx (BT). Gateway binds loopback only.
          'systemctl daemon-reload',
          'systemctl enable launchos-gateway',
          'systemctl restart launchos-gateway',
          'sleep 2',
          'systemctl is-active launchos-gateway',
          `ss -lptn "sport = :${GATEWAY_LOOPBACK_PORT}" | grep -E "127\\.0\\.0\\.1:${GATEWAY_LOOPBACK_PORT}|\\[::1\\]:${GATEWAY_LOOPBACK_PORT}" || ss -lptn "sport = :${GATEWAY_LOOPBACK_PORT}"`,
          `curl -fsS http://${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT}/health`,
        ].join('\n'),
        120_000,
      );

      return {
        host: target.host,
        publicPort: 80,
        listen: `${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT}`,
        healthUrl: `http://${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT}/health`,
        routesPath: REMOTE_ROUTES,
      };
    } finally {
      await runner.disconnect().catch(() => undefined);
    }
  }

  /**
   * Install independent BT nginx vhost for *.rootDomain → loopback Gateway.
   * Never modifies zsaos.com.conf / www. Safe path: nginx -t then -s reload only.
   */
  async installWildcardNginxProxy(
    target: GatewayDeployTarget,
    rootDomain: string,
  ): Promise<{ confPath: string; tested: boolean; reloaded: boolean }> {
    const zone = rootDomain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!zone || zone.includes(' ')) {
      throw new RemoteRunnerError('Invalid root domain for nginx wildcard');
    }
    const confName = `launchos-wildcard-${zone.replace(/\./g, '-')}.conf`;
    const confPath = `${BT_VHOST_DIR}/${confName}`;
    const confBody = [
      '# Managed by LaunchOS — do not put apex/www here.',
      '# Exact server_name for apex/www keep priority in their own conf files.',
      'server {',
      '    listen 80;',
      `    server_name *.${zone};`,
      '',
      '    location / {',
      `        proxy_pass http://${GATEWAY_LOOPBACK_HOST}:${GATEWAY_LOOPBACK_PORT};`,
      '        proxy_http_version 1.1;',
      '        proxy_set_header Host $host;',
      '        proxy_set_header X-Real-IP $remote_addr;',
      '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '        proxy_set_header X-Forwarded-Proto $scheme;',
      '        proxy_set_header Connection "";',
      '    }',
      '}',
      '',
    ].join('\n');

    const runner = new RemoteRunner();
    const dir = await mkdtemp(join(tmpdir(), 'launchos-nginx-'));
    try {
      await runner.connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        readyTimeoutMs: 20_000,
      });

      // Refuse to touch apex site files
      await this.run(
        runner,
        [
          'set -eux',
          `test -d ${BT_VHOST_DIR}`,
          `test -x ${BT_NGINX_BIN}`,
          `test -f ${BT_VHOST_DIR}/${zone}.conf`,
          // Ensure we never overwrite apex conf
          `test ! -f ${confPath} || true`,
        ].join('\n'),
        30_000,
      );

      const localConf = join(dir, confName);
      await writeFile(localConf, confBody, 'utf8');
      await runner.upload(localConf, confPath, { timeoutMs: 60_000 });

      const test = await runner.execute(
        `set -e; ${BT_NGINX_BIN} -t 2>&1`,
        { timeoutMs: 30_000 },
      );
      if (test.exitCode !== 0) {
        await runner.execute(`rm -f ${confPath}`, { timeoutMs: 15_000 }).catch(() => undefined);
        throw new RemoteRunnerError(
          `nginx -t failed; new conf removed. ${test.stderr || test.stdout}`.trim(),
        );
      }

      const reload = await runner.execute(`set -e; ${BT_NGINX_BIN} -s reload 2>&1`, {
        timeoutMs: 30_000,
      });
      if (reload.exitCode !== 0) {
        throw new RemoteRunnerError(
          `nginx reload failed. ${reload.stderr || reload.stdout}`.trim(),
        );
      }

      return { confPath, tested: true, reloaded: true };
    } finally {
      await runner.disconnect().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async syncRoutes(target: GatewayDeployTarget, table: GatewayRouteTable): Promise<void> {
    const runner = new RemoteRunner();
    const dir = await mkdtemp(join(tmpdir(), 'launchos-gw-routes-'));
    try {
      await runner.connect({
        host: target.host,
        port: target.port ?? 22,
        username: target.username,
        password: target.password,
        readyTimeoutMs: 20_000,
      });
      const local = join(dir, 'routes.json');
      await writeFile(local, JSON.stringify(table, null, 2), 'utf8');
      await this.run(runner, `mkdir -p ${REMOTE_ROOT}`, 15_000);
      await runner.upload(local, REMOTE_ROUTES, { timeoutMs: 60_000 });
      // routes-gateway reloads by file mtime on each request — do not HUP (Node may exit).
    } finally {
      await runner.disconnect().catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async ensureBundleDir(sourceGatewayCjs: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'launchos-gw-bundle-'));
    await mkdir(dir, { recursive: true });
    const { copyFile } = await import('node:fs/promises');
    await copyFile(sourceGatewayCjs, join(dir, 'gateway.cjs'));
    return dir;
  }

  private async run(
    runner: RemoteRunner,
    script: string,
    timeoutMs: number,
  ): Promise<void> {
    const result = await runner.execute(script, { timeoutMs });
    if (result.exitCode !== 0) {
      throw new RemoteRunnerError(
        result.stderr.trim() || result.stdout.trim() || 'Remote gateway command failed',
      );
    }
  }
}
