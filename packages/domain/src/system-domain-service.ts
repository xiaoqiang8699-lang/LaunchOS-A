import {
  ApplicationDnsStatus,
  ApplicationDomainStatus,
  ApplicationDomainType,
  PrismaClient,
  ServiceStatus,
  SystemDnsMode,
  type SystemDomainConfig,
} from '@launchos/database';
import { decryptCredential } from '@launchos/shared';
import {
  readGatewayPublicIp,
  readGatewayServerId,
  readSystemDomainZone,
} from './constants';
import { verifyWildcardDns, type WildcardDnsVerifyResult } from './dns-verify';
import { GatewayRemoteDeployer } from './gateway-deployer';
import { emptyRouteTable, type GatewayRouteTable } from './gateway-routes';

export type SystemDomainStatusView = {
  rootDomain: string;
  gatewayConfigured: boolean;
  gatewayServerId: string | null;
  gatewayPublicIp: string | null;
  gatewayReachable: boolean;
  gatewayHealth: string | null;
  dnsMode: SystemDnsMode;
  dnsStatus: ApplicationDnsStatus;
  lastVerifiedAt: string | null;
  wildcardCheck: WildcardDnsVerifyResult | null;
  usingDevDefaultDomain: boolean;
};

export class SystemDomainService {
  private readonly deployer = new GatewayRemoteDeployer();

  constructor(private readonly prisma: PrismaClient) {}

  async getOrCreateConfig(): Promise<SystemDomainConfig> {
    const existing = await this.prisma.systemDomainConfig.findFirst({
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      return this.applyEnvOverrides(existing);
    }
    const created = await this.prisma.systemDomainConfig.create({
      data: {
        rootDomain: readSystemDomainZone(),
        gatewayPublicIp: readGatewayPublicIp(),
        gatewayServerId: readGatewayServerId(),
        dnsMode: SystemDnsMode.MANUAL,
        dnsStatus: ApplicationDnsStatus.PENDING,
      },
    });
    return created;
  }

  async getStatus(): Promise<SystemDomainStatusView> {
    const config = await this.getOrCreateConfig();
    const health = config.gatewayPublicIp
      ? await probeGatewayHealth(config.gatewayPublicIp, config.rootDomain)
      : { reachable: false, body: null };

    return {
      rootDomain: config.rootDomain,
      gatewayConfigured: Boolean(config.gatewayPublicIp && config.gatewayServerId),
      gatewayServerId: config.gatewayServerId,
      gatewayPublicIp: config.gatewayPublicIp,
      gatewayReachable: health.reachable,
      gatewayHealth: health.body,
      dnsMode: config.dnsMode,
      dnsStatus: config.dnsStatus,
      lastVerifiedAt: config.lastVerifiedAt?.toISOString() ?? null,
      wildcardCheck: null,
      usingDevDefaultDomain: isDevDefaultDomain(config.rootDomain),
    };
  }

  async verify(): Promise<SystemDomainStatusView & { message: string }> {
    const config = await this.getOrCreateConfig();
    const publicIp = config.gatewayPublicIp?.trim() || '';
    if (!publicIp) {
      return {
        ...(await this.getStatus()),
        message: '未配置 LAUNCHOS_GATEWAY_PUBLIC_IP，无法验证公网 DNS',
      };
    }

    const health = await probeGatewayHealth(publicIp, config.rootDomain);
    if (!health.reachable) {
      await this.prisma.systemDomainConfig.update({
        where: { id: config.id },
        data: { dnsStatus: ApplicationDnsStatus.PENDING },
      });
      return {
        ...(await this.getStatus()),
        message: 'Gateway 公网入口不可达，DNS 保持 PENDING',
      };
    }

    if (isDevDefaultDomain(config.rootDomain)) {
      return {
        ...(await this.getStatus()),
        message:
          '当前系统根域名为开发默认值 launchos.app，未证明可控。请配置 LAUNCHOS_SYSTEM_DOMAIN 为你拥有的域名后再验证。',
      };
    }

    const wildcard = await verifyWildcardDns(config.rootDomain, publicIp);
    const dnsStatus = wildcard.verified
      ? ApplicationDnsStatus.ACTIVE
      : ApplicationDnsStatus.FAILED;

    await this.prisma.systemDomainConfig.update({
      where: { id: config.id },
      data: {
        dnsStatus,
        lastVerifiedAt: new Date(),
      },
    });

    if (wildcard.verified) {
      await this.prisma.applicationDomain.updateMany({
        where: {
          type: ApplicationDomainType.SYSTEM,
          status: ApplicationDomainStatus.ACTIVE,
        },
        data: { dnsStatus: ApplicationDnsStatus.ACTIVE },
      });
      await this.syncGatewayRoutes().catch(() => undefined);
    }

    const status = await this.getStatus();
    return {
      ...status,
      wildcardCheck: wildcard,
      message: wildcard.verified
        ? 'Wildcard DNS 真实验证通过'
        : 'Wildcard DNS 验证失败：随机子域名未解析到 Gateway 公网 IP',
    };
  }

  async deployGateway(gatewayCjsPath: string): Promise<{
    deployed: boolean;
    result?: { host: string; healthUrl: string };
    message: string;
  }> {
    const config = await this.getOrCreateConfig();
    const serverId = config.gatewayServerId || readGatewayServerId();
    if (!serverId) {
      return {
        deployed: false,
        message: '未配置 LAUNCHOS_GATEWAY_SERVER_ID，无法远程部署 Gateway',
      };
    }

    const server = await this.prisma.serverInstance.findUnique({
      where: { id: serverId },
    });
    if (!server) {
      return { deployed: false, message: 'Gateway ServerInstance 不存在' };
    }

    const password = decryptCredential(server.credentialEncrypted);
    const bundleDir = await this.deployer.ensureBundleDir(gatewayCjsPath);
    const deployed = await this.deployer.deploy(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password,
      },
      bundleDir,
    );

    const publicIp = config.gatewayPublicIp?.trim() || server.host;
    await this.prisma.systemDomainConfig.update({
      where: { id: config.id },
      data: {
        gatewayServerId: server.id,
        gatewayPublicIp: publicIp,
      },
    });

    await this.syncGatewayRoutes();
    return {
      deployed: true,
      result: { host: deployed.host, healthUrl: deployed.healthUrl },
      message: `Gateway 已部署到 ${deployed.listen}（本机回环，由 Nginx 对外提供 :80）`,
    };
  }

  async installWildcardNginx(): Promise<{
    installed: boolean;
    confPath?: string;
    message: string;
  }> {
    const config = await this.getOrCreateConfig();
    const serverId = config.gatewayServerId || readGatewayServerId();
    if (!serverId) {
      return { installed: false, message: '未配置 LAUNCHOS_GATEWAY_SERVER_ID' };
    }
    const server = await this.prisma.serverInstance.findUnique({ where: { id: serverId } });
    if (!server) {
      return { installed: false, message: 'Gateway ServerInstance 不存在' };
    }
    const password = decryptCredential(server.credentialEncrypted);
    const result = await this.deployer.installWildcardNginxProxy(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password,
      },
      config.rootDomain,
    );
    return {
      installed: true,
      confPath: result.confPath,
      message: `已安装 Nginx wildcard 并 reload：${result.confPath}`,
    };
  }

  /**
   * Ensure RUNNING apps have SYSTEM domains under current rootDomain, then sync routes.
   * Does not delete legacy *.launchos.app records.
   */
  async ensureCurrentZoneSystemDomains(): Promise<{
    domains: string[];
    table: GatewayRouteTable;
  }> {
    const config = await this.getOrCreateConfig();
    const zone = config.rootDomain;
    const { DomainManager } = await import('./domain-manager');
    const domains = new DomainManager(this.prisma);

    const running = await this.prisma.serviceInstance.findMany({
      where: { status: ServiceStatus.RUNNING },
      orderBy: { updatedAt: 'desc' },
      select: {
        externalPort: true,
        port: true,
        project: { select: { id: true, slug: true } },
        server: { select: { host: true } },
      },
    });

    const created: string[] = [];
    const seenProjects = new Set<string>();
    for (const item of running) {
      if (!item.project || seenProjects.has(item.project.id)) continue;
      seenProjects.add(item.project.id);
      const record = await domains.createSystemDomain(item.project.id, item.project.slug);
      const activated = await domains.activateGatewayRouting(record.domain);
      const port = item.externalPort ?? item.port;
      const host = item.server?.host?.trim();
      if (host && port && port > 0) {
        await domains.bindRuntime(activated.domain, { host, port });
      }
      if (activated.domain.endsWith(`.${zone}`)) {
        created.push(activated.domain);
      }
    }

    const table = await this.syncGatewayRoutes();
    return { domains: created, table };
  }

  async syncGatewayRoutes(): Promise<GatewayRouteTable> {
    const config = await this.getOrCreateConfig();
    const table = await this.buildRouteTable(config.rootDomain);

    const serverId = config.gatewayServerId || readGatewayServerId();
    if (!serverId) {
      return table;
    }
    const server = await this.prisma.serverInstance.findUnique({ where: { id: serverId } });
    if (!server) {
      return table;
    }
    const password = decryptCredential(server.credentialEncrypted);
    await this.deployer.syncRoutes(
      {
        host: server.host,
        port: server.port,
        username: server.username,
        password,
      },
      table,
    );
    return table;
  }

  async buildRouteTable(rootDomain = readSystemDomainZone()): Promise<GatewayRouteTable> {
    const table = emptyRouteTable(rootDomain);
    const zoneSuffix = `.${rootDomain}`;
    const config = await this.prisma.systemDomainConfig.findFirst({
      select: { gatewayServerId: true, gatewayPublicIp: true },
    });
    const gatewayServer = config?.gatewayServerId
      ? await this.prisma.serverInstance.findUnique({
          where: { id: config.gatewayServerId },
          select: { id: true, host: true },
        })
      : null;
    const gatewayHost = gatewayServer?.host?.trim() || config?.gatewayPublicIp?.trim() || null;

    const domains = await this.prisma.applicationDomain.findMany({
      where: {
        type: ApplicationDomainType.SYSTEM,
        status: ApplicationDomainStatus.ACTIVE,
        domain: { endsWith: zoneSuffix },
      },
      select: {
        domain: true,
        projectId: true,
        deployableUnitId: true,
        runtimeHost: true,
        runtimePort: true,
      },
    });

    for (const item of domains) {
      const unitFilter = item.deployableUnitId
        ? { deployableUnitId: item.deployableUnitId }
        : {};
      const instance = await this.prisma.serviceInstance.findFirst({
        where: {
          projectId: item.projectId,
          status: ServiceStatus.RUNNING,
          ...unitFilter,
        },
        orderBy: { updatedAt: 'desc' },
        select: {
          status: true,
          port: true,
          externalPort: true,
          deployableUnitId: true,
          server: { select: { host: true } },
        },
      });
      const fallback =
        instance ??
        (await this.prisma.serviceInstance.findFirst({
          where: { projectId: item.projectId, ...unitFilter },
          orderBy: { updatedAt: 'desc' },
          select: {
            status: true,
            port: true,
            externalPort: true,
            deployableUnitId: true,
            server: { select: { host: true } },
          },
        }));
      if (!fallback) {
        table.routes[item.domain] = {
          host: '127.0.0.1',
          port: 0,
          status: 'unavailable',
          projectId: item.projectId,
        };
        continue;
      }

      const port = item.runtimePort || fallback.externalPort || fallback.port || 0;
      const serviceHost = fallback.server?.host?.trim() || null;
      const boundHost = item.runtimeHost?.trim() || null;
      // Prefer loopback when Gateway and the unit runtime share a host (or runtime already bound to loopback).
      const sameHost =
        Boolean(gatewayHost) &&
        Boolean(serviceHost) &&
        gatewayHost === serviceHost;
      const host =
        boundHost === '127.0.0.1' || sameHost
          ? '127.0.0.1'
          : boundHost || serviceHost || '127.0.0.1';

      table.routes[item.domain] = {
        host,
        port,
        status:
          fallback.status === ServiceStatus.RUNNING && port > 0
            ? 'running'
            : fallback.status === ServiceStatus.STOPPED
              ? 'stopped'
              : 'unavailable',
        projectId: item.projectId,
      };
    }
    table.updatedAt = new Date().toISOString();
    return table;
  }

  private async applyEnvOverrides(config: SystemDomainConfig): Promise<SystemDomainConfig> {
    const rootDomain = readSystemDomainZone();
    const gatewayPublicIp = readGatewayPublicIp();
    const gatewayServerId = readGatewayServerId();
    const next = {
      rootDomain: rootDomain || config.rootDomain,
      gatewayPublicIp: gatewayPublicIp ?? config.gatewayPublicIp,
      gatewayServerId: gatewayServerId ?? config.gatewayServerId,
    };
    if (
      next.rootDomain === config.rootDomain &&
      next.gatewayPublicIp === config.gatewayPublicIp &&
      next.gatewayServerId === config.gatewayServerId
    ) {
      return config;
    }
    return this.prisma.systemDomainConfig.update({
      where: { id: config.id },
      data: next,
    });
  }
}

function isDevDefaultDomain(domain: string): boolean {
  return domain.trim().toLowerCase() === 'launchos.app';
}

async function probeGatewayHealth(
  publicIp: string,
  rootDomain = readSystemDomainZone(),
): Promise<{ reachable: boolean; body: string | null }> {
  const probeHost = `launchos-health.${rootDomain}`;
  // Node fetch cannot override Host; use http.request for nginx→gateway path.
  const { request } = await import('node:http');
  const tryOnce = (port: number) =>
    new Promise<{ reachable: boolean; body: string | null }>((resolve) => {
      const req = request(
        {
          hostname: publicIp,
          port,
          path: '/health',
          method: 'GET',
          headers: { Host: probeHost },
          timeout: 8_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              reachable: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300 && body.includes('launchos-gateway'),
              body,
            });
          });
        },
      );
      req.on('error', () => resolve({ reachable: false, body: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ reachable: false, body: null });
      });
      req.end();
    });

  const result = await tryOnce(80);
  if (result.reachable) return result;
  return { reachable: false, body: null };
}
