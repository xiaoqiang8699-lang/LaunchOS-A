import {
  ApplicationDnsStatus,
  ApplicationDomainStatus,
  ApplicationDomainType,
  ApplicationSslStatus,
  PrismaClient,
  ServiceStatus,
  type ApplicationDomain,
} from '@launchos/database';
import {
  canonicalSystemDomain,
  readSystemDomainZone,
  systemDomainFromSlug,
  toHostLabel,
  toVisitUrls,
} from './constants';
import {
  createSystemDomainDnsProvider,
  type SystemDomainDnsProvider,
} from './dns-provider';

export class DomainManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainManagerError';
  }
}

export type RuntimeBinding = {
  host: string;
  port: number;
  projectId: string;
  domain: string;
  source: 'service-instance';
};

export type RouteResolveResult =
  | { kind: 'ok'; binding: RuntimeBinding }
  | { kind: 'not_found' }
  | { kind: 'stopped'; domain: string; projectId: string }
  | { kind: 'unavailable'; domain: string; projectId: string };

export class DomainManager {
  private readonly dns: SystemDomainDnsProvider;

  constructor(
    private readonly prisma: PrismaClient,
    dnsProvider?: SystemDomainDnsProvider,
  ) {
    this.dns = dnsProvider ?? createSystemDomainDnsProvider();
  }

  async createSystemDomain(
    projectId: string,
    slug: string,
    options: { deployableUnitId?: string | null; unitLabel?: string | null } = {},
  ): Promise<ApplicationDomain> {
    const unitPart = options.unitLabel ? toHostLabel(options.unitLabel) : null;
    const baseSlug = unitPart && unitPart !== slug ? `${unitPart}-${slug}` : slug;
    const domain = await this.allocateSystemDomain(baseSlug);
    const zone = readSystemDomainZone();
    const zoneSuffix = `.${zone}`;

    if (options.deployableUnitId) {
      const existingForUnit = await this.prisma.applicationDomain.findFirst({
        where: {
          projectId,
          deployableUnitId: options.deployableUnitId,
          type: ApplicationDomainType.SYSTEM,
          status: { not: ApplicationDomainStatus.FAILED },
          OR: [{ domain: zone }, { domain: { endsWith: zoneSuffix } }],
        },
        orderBy: { createdAt: 'asc' },
      });
      if (existingForUnit) {
        return existingForUnit;
      }
      await this.prisma.applicationDomain.updateMany({
        where: {
          projectId,
          deployableUnitId: options.deployableUnitId,
          type: ApplicationDomainType.SYSTEM,
          NOT: {
            OR: [{ domain: zone }, { domain: { endsWith: zoneSuffix } }],
          },
        },
        data: { status: ApplicationDomainStatus.FAILED, dnsStatus: ApplicationDnsStatus.FAILED },
      });
    } else {
      const existingExact = await this.prisma.applicationDomain.findFirst({
        where: {
          projectId,
          deployableUnitId: null,
          type: ApplicationDomainType.SYSTEM,
          domain,
          status: { not: ApplicationDomainStatus.FAILED },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (existingExact) {
        return existingExact;
      }
    }

    await this.dns.createSystemDomain(domain);

    // Never inherit SystemDomainConfig.dnsStatus=ACTIVE for a hostname we have not resolved.
    const created = await this.prisma.applicationDomain.create({
      data: {
        projectId,
        deployableUnitId: options.deployableUnitId ?? null,
        domain,
        type: ApplicationDomainType.SYSTEM,
        status: ApplicationDomainStatus.CREATING,
        dnsStatus: ApplicationDnsStatus.PENDING,
        sslStatus: ApplicationSslStatus.PENDING,
      },
    });
    console.log(
      `LaunchOS system domain created ${created.domain} dns=${created.dnsStatus} provider=${this.dns.mode}`,
    );
    return created;
  }

  /**
   * Mark gateway routing ready. Public dnsStatus becomes ACTIVE only when
   * SystemDomainConfig wildcard DNS is VERIFIED, or real resolve points to Gateway IP.
   */
  async activateGatewayRouting(domain: string): Promise<ApplicationDomain> {
    const record = await this.requireDomain(domain);
    // Always resolve this hostname — never inherit SystemDomainConfig.dnsStatus.
    const dnsCheck = await this.dns.verifyDnsRecord(record.domain);
    const dnsStatus = dnsCheck.verified
      ? ApplicationDnsStatus.ACTIVE
      : ApplicationDnsStatus.PENDING;

    const updated = await this.prisma.applicationDomain.update({
      where: { id: record.id },
      data: {
        status: ApplicationDomainStatus.ACTIVE,
        dnsStatus,
        sslStatus: ApplicationSslStatus.PENDING,
      },
    });
    console.log(
      `LaunchOS domain ${updated.domain} gateway=ACTIVE dns=${updated.dnsStatus} ssl=${updated.sslStatus}`,
    );
    return updated;
  }

  /** @deprecated Prefer activateGatewayRouting — kept for callers; does not fake DNS/SSL. */
  async verifyDomain(domain: string): Promise<{ verified: boolean; domain: ApplicationDomain }> {
    const updated = await this.activateGatewayRouting(domain);
    return { verified: true, domain: updated };
  }

  /**
   * Cache hint only. Gateway always resolves live ServiceInstance targets.
   */
  async bindRuntime(domain: string, runtime: { host: string; port: number }): Promise<ApplicationDomain> {
    if (!runtime.host || !Number.isInteger(runtime.port) || runtime.port <= 0) {
      throw new DomainManagerError('Runtime host and port are required');
    }
    if (!isAllowedRuntimeHost(runtime.host)) {
      throw new DomainManagerError('Runtime host is not allowed');
    }

    const record = await this.requireDomain(domain);
    const updated = await this.prisma.applicationDomain.update({
      where: { id: record.id },
      data: {
        runtimeHost: runtime.host,
        runtimePort: runtime.port,
        status:
          record.status === ApplicationDomainStatus.FAILED
            ? ApplicationDomainStatus.FAILED
            : ApplicationDomainStatus.ACTIVE,
        sslStatus: ApplicationSslStatus.PENDING,
      },
    });
    console.log(`LaunchOS domain ${updated.domain} runtime hint ${runtime.host}:${runtime.port}`);
    return updated;
  }

  async ensureSystemDomainForProject(projectId: string): Promise<ApplicationDomain> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true },
    });
    if (!project) {
      throw new DomainManagerError('Project not found');
    }
    const domain = await this.createSystemDomain(project.id, project.slug);
    return this.activateGatewayRouting(domain.domain);
  }

  async resolveRoute(hostname: string): Promise<RouteResolveResult> {
    const domain = canonicalSystemDomain(hostname) ?? hostname.trim().toLowerCase().split(':')[0];
    if (!domain) {
      return { kind: 'not_found' };
    }

    const record = await this.prisma.applicationDomain.findUnique({
      where: { domain },
      select: {
        status: true,
        projectId: true,
        domain: true,
      },
    });
    if (!record) {
      return { kind: 'not_found' };
    }
    if (record.status !== ApplicationDomainStatus.ACTIVE) {
      if (record.status === ApplicationDomainStatus.FAILED) {
        return { kind: 'unavailable', domain: record.domain, projectId: record.projectId };
      }
      return { kind: 'stopped', domain: record.domain, projectId: record.projectId };
    }

    const binding = await this.resolveServiceBinding(record.projectId, record.domain);
    if (!binding) {
      const anyInstance = await this.prisma.serviceInstance.findFirst({
        where: { projectId: record.projectId },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      });
      if (!anyInstance || anyInstance.status === ServiceStatus.STOPPED) {
        return { kind: 'stopped', domain: record.domain, projectId: record.projectId };
      }
      return { kind: 'unavailable', domain: record.domain, projectId: record.projectId };
    }
    return { kind: 'ok', binding };
  }

  async resolveRuntime(hostname: string): Promise<RuntimeBinding | null> {
    const result = await this.resolveRoute(hostname);
    return result.kind === 'ok' ? result.binding : null;
  }

  visitUrls(record: Pick<ApplicationDomain, 'domain' | 'status' | 'sslStatus' | 'dnsStatus'>): {
    visitUrl: string | null;
    localVisitUrl: string | null;
    dnsReady: boolean;
    gatewayReady: boolean;
  } {
    return toVisitUrls(record);
  }

  private async resolveServiceBinding(
    projectId: string,
    domain: string,
  ): Promise<RuntimeBinding | null> {
    const domainRecord = await this.prisma.applicationDomain.findUnique({
      where: { domain },
      select: { deployableUnitId: true },
    });
    const instance = await this.prisma.serviceInstance.findFirst({
      where: {
        projectId,
        status: ServiceStatus.RUNNING,
        ...(domainRecord?.deployableUnitId
          ? { deployableUnitId: domainRecord.deployableUnitId }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        port: true,
        externalPort: true,
        server: { select: { host: true } },
      },
    });
    if (!instance) {
      return null;
    }

    const accessPort = instance.externalPort ?? instance.port;
    if (!accessPort || accessPort <= 0) {
      return null;
    }

    const host = '127.0.0.1';
    if (!isAllowedRuntimeHost(host)) {
      console.error(`LaunchOS gateway blocked unsafe host for ${domain}`);
      return null;
    }

    return {
      host,
      port: accessPort,
      projectId,
      domain,
      source: 'service-instance',
    };
  }

  private async allocateSystemDomain(slug: string): Promise<string> {
    const zone = readSystemDomainZone();
    const preferred = systemDomainFromSlug(slug, zone);
    const taken = await this.prisma.applicationDomain.findUnique({
      where: { domain: preferred },
      select: { id: true },
    });
    if (!taken) {
      return preferred;
    }
    const shortId = Date.now().toString(36).slice(-6);
    const label = `${toHostLabel(slug) || 'app'}-${shortId}`;
    return systemDomainFromSlug(label, zone);
  }

  private async requireDomain(domain: string): Promise<ApplicationDomain> {
    const normalized = domain.trim().toLowerCase();
    const record = await this.prisma.applicationDomain.findUnique({
      where: { domain: normalized },
    });
    if (!record) {
      throw new DomainManagerError(`Domain ${normalized} not found`);
    }
    return record;
  }
}

function isAllowedRuntimeHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value || value.includes('/') || value.includes('\\') || value.includes('@')) {
    return false;
  }
  // Block obvious open-proxy tricks; allow IPv4, localhost, and hostnames.
  if (value === '0.0.0.0' || value === '::' || value === '[::]') {
    return false;
  }
  return /^[a-z0-9.:[\]-]+$/i.test(value);
}
