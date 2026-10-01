import {
  CertificateStatus,
  DomainStatus,
  DomainType,
  PrismaClient,
} from '@launchos/database';
import { MockDomainProvider } from '@launchos/providers';

const MOCK_ISSUER = 'LaunchOS Mock CA';
const CERTIFICATE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const LAUNCHOS_ZONE = 'launchos.local';

export class DomainServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainServiceError';
  }
}

export class DomainService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly domainProvider = new MockDomainProvider(),
  ) {}

  async assignDefaultSubdomain(input: {
    projectId: string;
    projectName: string;
    projectSlug: string;
    serviceInstanceId: string;
    target?: string;
  }) {
    const domain = await this.allocateSubdomain(input.projectName, input.projectSlug);
    return this.provision({
      projectId: input.projectId,
      serviceInstanceId: input.serviceInstanceId,
      domain,
      type: DomainType.SUBDOMAIN,
      target: input.target ?? '127.0.0.1',
    });
  }

  async assignCustomDomain(input: {
    projectId: string;
    serviceInstanceId: string;
    domain: string;
    target?: string;
  }) {
    const domain = normalizeDomain(input.domain);
    if (!domain) {
      throw new DomainServiceError('Domain is required');
    }
    return this.provision({
      projectId: input.projectId,
      serviceInstanceId: input.serviceInstanceId,
      domain,
      type: DomainType.CUSTOM,
      target: input.target ?? '127.0.0.1',
    });
  }

  private async provision(input: {
    projectId: string;
    serviceInstanceId: string;
    domain: string;
    type: DomainType;
    target: string;
  }) {
    const existing = await this.prisma.domainRecord.findUnique({
      where: { domain: input.domain },
      select: { id: true },
    });
    if (existing) {
      throw new DomainServiceError(`Domain ${input.domain} is already assigned`);
    }

    const record = await this.domainProvider.createRecord({
      domain: input.domain,
      type: 'A',
      value: input.target,
    });
    const verification = await this.domainProvider.verifyDomain(input.domain);
    const status = verification.verified ? DomainStatus.ACTIVE : DomainStatus.FAILED;
    const certificateStatus = verification.verified
      ? CertificateStatus.ACTIVE
      : CertificateStatus.FAILED;

    const created = await this.prisma.domainRecord.create({
      data: {
        projectId: input.projectId,
        serviceInstanceId: input.serviceInstanceId,
        domain: input.domain,
        type: input.type,
        provider: this.domainProvider.name,
        status,
        certificates: {
          create: {
            issuer: MOCK_ISSUER,
            expiresAt: new Date(Date.now() + CERTIFICATE_TTL_MS),
            status: certificateStatus,
          },
        },
      },
      include: {
        certificates: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    console.log(
      `LaunchOS Domain ${created.domain} ${created.status} via ${this.domainProvider.name} record ${record.recordId}`,
    );
    return created;
  }

  private async allocateSubdomain(projectName: string, projectSlug: string): Promise<string> {
    const label = toHostLabel(projectName) || toHostLabel(projectSlug) || 'project';
    const preferred = `${label}.${LAUNCHOS_ZONE}`;
    const taken = await this.prisma.domainRecord.findUnique({
      where: { domain: preferred },
      select: { id: true },
    });
    if (!taken) {
      return preferred;
    }
    return `${label}-${Date.now().toString(36)}.${LAUNCHOS_ZONE}`;
  }
}

function toHostLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}
