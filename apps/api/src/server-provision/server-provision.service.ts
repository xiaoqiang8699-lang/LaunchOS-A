import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CloudResourceStatus,
  CloudResourceType,
  WorkspaceRole,
  type Prisma,
} from '@launchos/database';
import {
  ALIYUN_PROVIDER_TYPE,
  AlibabaCloudCapabilityService,
  AlibabaCloudEcsPlanner,
  AlibabaCloudEcsProvisioner,
} from '@launchos/providers';
import {
  SERVER_PROFILE_LABELS,
  SERVER_PROVISION_PHASE_LABELS,
  SERVER_PROVISION_PRODUCT_STEPS,
  SERVER_RESOURCE_PROFILES,
  ECS_DENIED_PUBLIC_PORT_RANGES,
  ECS_LOGIN_MODE_V1,
  ECS_PUBLIC_INGRESS_PORTS,
  advanceServerCreateGeneration,
  archiveServerProvisionCurrentFailure,
  buildLaunchosEcsTags,
  buildRunInstancesRequestPreview,
  classifyServerCreateFailureKind,
  cloudEcsErrorUserMessage,
  encryptCredential,
  generateManagedEcsPassword,
  mapServerPhaseToProductLabel,
  newServerOperationId,
  pickRegionFromHints,
  decideServerProvisionCreatingAction,
  pricesRequireReconfirmation,
  sanitizeEcsInstanceName,
  shouldRotateServerCreateClientToken,
  serverPriceFingerprint,
  validateRunInstancesRequestPreflight,
  type ResolvedServerPlan,
  type ServerProvisionPhase,
  type ServerProvisionProfile,
} from '@launchos/shared';
import { PrismaService } from '../database/prisma.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import { decryptProviderSecrets } from '../security/credential-cipher';
import { ServerProvisionQueueService } from '../queue/server-provision-queue.service';
import { WorkerPresenceService } from '../queue/worker-presence.service';

const WRITE_ROLES: WorkspaceRole[] = [WorkspaceRole.OWNER, WorkspaceRole.ADMIN];

type Meta = Record<string, unknown>;

@Injectable()
export class ServerProvisionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaceAccess: WorkspaceAccessService,
    private readonly queue: ServerProvisionQueueService,
    private readonly workerPresence: WorkerPresenceService,
  ) {}

  async getDryRunPreview(
    userId: string,
    projectId: string,
    profile: ServerProvisionProfile = 'STANDARD',
  ) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    const plan = await this.resolveCurrentServerPlan(project.workspaceId, projectId, profile);
    const capability = await this.probeCapability(project.workspaceId, plan.regionId);
    const gates = this.evaluateCreateGates(capability, plan);
    const operationId = newServerOperationId();
    const instanceName = sanitizeEcsInstanceName(project.slug || projectId);
    const tags = buildLaunchosEcsTags({
      cloudResourceId: 'preview',
      projectId,
      workspaceId: project.workspaceId,
    });
    const securityGroupPlan = await this.previewSecurityGroupPlan(
      project.workspaceId,
      plan.regionId,
      plan.vpcId,
    );
    const preview = buildRunInstancesRequestPreview({
      plan,
      instanceName,
      clientToken: operationId,
      securityGroupId: securityGroupPlan.securityGroupId,
      loginMode: ECS_LOGIN_MODE_V1,
      keyPairName: null,
      tags,
    });
    const preflight = validateRunInstancesRequestPreflight({
      regionId: plan.regionId,
      zoneId: plan.zoneId,
      instanceType: plan.instanceType,
      imageId: plan.imageId,
      systemDiskCategory: plan.systemDiskCategory,
      systemDiskSize: plan.systemDiskGb,
      vSwitchId: plan.vSwitchId,
      securityGroupId: securityGroupPlan.securityGroupId,
      instanceName,
      chargeType: 'PostPaid',
      internetChargeType: 'PayByTraffic',
      internetMaxBandwidthOut: 5,
      clientToken: operationId,
      loginMode: ECS_LOGIN_MODE_V1,
      // dry-run: password not generated yet — report presence as true for schema check via length probe
      passwordPresent: true,
      passwordLength: 16,
      tags,
    });
    return {
      dryRun: true,
      RUN_INSTANCES_CALLED: false,
      currentResolvedServerPlan: plan,
      priceEstimate: plan.priceEstimate,
      capabilityReadiness: {
        ecs: capability?.capabilities.ecs.status,
        ecsActions: capability?.capabilities.ecs.actions || null,
        billingOrder: capability?.BILLING_ORDER_PERMISSION,
        'ecs.read': actionsReadiness(capability, 'read'),
        'ecs.price': actionsReadiness(capability, 'price'),
        'ecs.instanceCreate': actionsReadiness(capability, 'instanceCreate'),
        'ecs.securityGroupRead': actionsReadiness(capability, 'securityGroupRead'),
        'ecs.securityGroupCreate': actionsReadiness(capability, 'securityGroupCreate'),
        'ecs.securityGroupAuthorize': actionsReadiness(capability, 'securityGroupAuthorize'),
        'ecs.imageRead': actionsReadiness(capability, 'imageRead'),
        'vpc.read': capability?.capabilities.vpc?.status || null,
        billing: capability?.BILLING_ORDER_PERMISSION || null,
        'billing.permission': capability?.BILLING_ORDER_PERMISSION || null,
        'billing.accountBalance':
          capability?.capabilities.billing?.actions?.accountBalance || 'UNKNOWN',
      },
      billingReadiness: {
        message:
          capability?.capabilities.billing?.actions?.accountBalance === 'INSUFFICIENT'
            ? '阿里云账户可用余额不足，请充值或补足余额后再重试创建服务器。'
            : capability?.capabilities.billing?.actions?.accountBalance === 'UNKNOWN'
              ? '订单权限已检测；账户余额无法可靠预判，以阿里云 RunInstances 结果为准。'
              : '账户支付状态需由阿里云最终确认。',
        ready: gates.billingReady,
        permission: capability?.BILLING_ORDER_PERMISSION || null,
        accountBalance: capability?.capabilities.billing?.actions?.accountBalance || 'UNKNOWN',
      },
      networkPlan: {
        regionId: plan.regionId,
        zoneId: plan.zoneId,
        vpcId: plan.vpcId,
        vSwitchId: plan.vSwitchId,
      },
      securityGroupPlan,
      login: {
        loginMode: ECS_LOGIN_MODE_V1,
        keyPairName: null,
        policy: 'PASSWORD_V1_FALLBACK',
        upgradeTarget: 'KEY_PAIR',
        generation: 'crypto.randomBytes',
        storage: 'AES-256-GCM',
        apiEcho: false,
        note: 'PASSWORD 是 v1 fallback，后续升级为 SSH Key Pair。密码只在真实创建时生成，API 不回显。',
      },
      image: { imageId: plan.imageId, imageName: plan.imageName },
      runInstancesRequestPreview: preview,
      runInstancesRequestValid: preflight.valid,
      missingFields: preflight.missingFields,
      passwordPresent: preflight.passwordPresent,
      resolvedRunInstancesRequest: preflight.resolvedRunInstancesRequest,
      reconcileCount: 0,
      attemptCounters: {
        runInstancesAttemptCount: 0,
        runInstancesSuccessCount: 0,
        createGeneration: 1,
      },
      gates,
      canCreate: gates.allReady,
      resume: await this.getResumeHint(projectId),
      notices: [
        '实际费用以阿里云账单为准。',
        'dry-run 不会调用 RunInstances。',
        '这台服务器创建后将产生阿里云费用。',
        '安全组在 PREPARING_SECURITY_GROUP 阶段复用或创建，公网只放行 22/80/443。',
        'PASSWORD 是 v1 fallback，后续升级为 SSH Key Pair。',
      ],
      role: membership.role,
    };
  }

  async create(
    userId: string,
    projectId: string,
    dto: {
      source?: string;
      profile?: ServerProvisionProfile;
      confirmBilling?: boolean;
      cloudResourceId?: string;
    },
  ) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);

    if (dto.source && dto.source !== 'MANAGED_CREATE') {
      throw new BadRequestException('仅支持 LaunchOS 帮我准备服务器（MANAGED_CREATE）');
    }
    if (!dto.confirmBilling) {
      throw new BadRequestException('请确认将在阿里云账号产生费用');
    }

    if (dto.cloudResourceId?.trim()) {
      return this.retry(userId, projectId, dto.cloudResourceId.trim());
    }

    const existing = await this.prisma.cloudResource.findFirst({
      where: {
        projectId,
        type: CloudResourceType.SERVER,
        status: { in: [CloudResourceStatus.CREATING, CloudResourceStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing?.status === CloudResourceStatus.CREATING) {
      const meta = asMeta(existing.metadata);
      const createGeneration = Math.max(1, Number(meta.createGeneration || 1));
      const queueBefore = await this.queue.getJobState(existing.id, createGeneration);
      const decision = decideServerProvisionCreatingAction({
        status: existing.status,
        phase: typeof meta.phase === 'string' ? meta.phase : null,
        providerResourceId: existing.providerResourceId,
        runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
        queueJobState: queueBefore.state,
        createGeneration,
      });

      if (decision.kind === 'already_in_progress') {
        return {
          ...this.toPublicStatus(existing),
          alreadyInProgress: true,
          safeResume: false,
          enqueueStrategy: 'reuse_inflight' as const,
          queueJobId: queueBefore.jobId,
          queueJobStateBefore: queueBefore.state,
          queueJobStateAfter: queueBefore.state,
          createGeneration,
        };
      }

      if (decision.kind === 'stale_reenqueue' || decision.kind === 'reconcile_first') {
        // Real stale recovery on POST provision — do not pretend "正在创建中".
        const resumed = await this.retry(userId, projectId, existing.id);
        return {
          ...resumed,
          safeResume: true,
          staleRecoveryKind: decision.kind,
          queueJobStateBefore: queueBefore.state,
          createGeneration:
            typeof resumed.createGeneration === 'number'
              ? resumed.createGeneration
              : createGeneration,
        };
      }

      throw new BadRequestException({
        message: '服务器正在创建中',
        code: 'SERVER_PROVISION_IN_PROGRESS',
        cloudResourceId: existing.id,
        queueJobState: queueBefore.state,
        reason: decision.reason,
      });
    }
    if (existing?.status === CloudResourceStatus.RUNNING) {
      return this.toPublicStatus(existing);
    }

    const failed = await this.prisma.cloudResource.findFirst({
      where: { projectId, type: CloudResourceType.SERVER, status: CloudResourceStatus.FAILED },
      orderBy: { createdAt: 'desc' },
    });
    if (failed) {
      return this.retry(userId, projectId, failed.id);
    }

    const profile = (dto.profile || 'STANDARD') as ServerProvisionProfile;
    const plan = await this.resolveCurrentServerPlan(project.workspaceId, projectId, profile);
    const capability = await this.probeCapability(project.workspaceId, plan.regionId);
    const gates = this.evaluateCreateGates(capability, plan);
    if (!gates.allReady) {
      throw new BadRequestException({
        message: gates.blockers[0] || '服务器创建前置条件未就绪',
        code: 'SERVER_PROVISION_GATE',
        gates,
      });
    }

    const presence = await this.workerPresence.getOnlineConsumer('serverProvision');
    const paused = await this.queue.isPaused();
    const consumerReady = presence.online && presence.queueReady.serverProvision && !paused;
    if (!consumerReady) {
      throw new ServiceUnavailableException({
        message: '服务器创建服务暂时不可用，请确认 worker 已启动。',
        code: 'SERVER_PROVISION_QUEUE_NOT_READY',
      });
    }

    const account = await this.requireAliyunAccount(project.workspaceId);
    const operationId = newServerOperationId();
    const createdAtIso = new Date().toISOString();
    const instanceName = sanitizeEcsInstanceName(project.slug || projectId);
    const password = generateManagedEcsPassword();

    const created = await this.prisma.cloudResource.create({
      data: {
        workspaceId: project.workspaceId,
        projectId,
        providerId: account.providerId,
        type: CloudResourceType.SERVER,
        externalId: 'pending',
        providerResourceId: null,
        region: plan.regionId,
        instanceType: plan.instanceType,
        status: CloudResourceStatus.CREATING,
        metadata: {
          resourceKind: 'ALIYUN_ECS',
          displayName: '阿里云云服务器',
          operationId,
          createGeneration: 1,
          createGenerations: [
            {
              generation: 1,
              operationId,
              attemptCount: 0,
              successCount: 0,
              createdAt: createdAtIso,
              closedAt: null,
            },
          ],
          generationAttemptCount: 0,
          generationSuccessCount: 0,
          phase: 'QUEUED',
          phases: [{ phase: 'QUEUED', at: createdAtIso, status: 'running' }],
          profile,
          currentResolvedServerPlan: plan,
          resolvedSku: plan,
          instanceName,
          loginMode: ECS_LOGIN_MODE_V1,
          passwordEncrypted: encryptCredential(password),
          runInstancesAttemptCount: 0,
          runInstancesSuccessCount: 0,
          runInstancesCompleted: false,
          confirmBillingAt: createdAtIso,
          confirmedPriceFingerprint: serverPriceFingerprint({
            currency: plan.priceEstimate?.currency,
            tradePrice: plan.priceEstimate?.tradePrice,
            hourlyPrice: plan.priceEstimate?.hourlyPrice,
            instanceType: plan.instanceType,
          }),
          billingNotice: '这台服务器正在产生阿里云费用。',
        } as Prisma.InputJsonObject,
      },
    });

    await this.queue.enqueue(created.id, operationId, 1);
    await this.prisma.auditLog.create({
      data: {
        workspaceId: project.workspaceId,
        userId,
        action: 'server_provision_started',
        metadata: {
          projectId,
          cloudResourceId: created.id,
          profile,
          region: plan.regionId,
          instanceType: plan.instanceType,
        },
      },
    });
    return this.toPublicStatus(created);
  }

  async retry(userId: string, projectId: string, id: string) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    const resource = await this.requireProjectServer(projectId, id);
    const meta = asMeta(resource.metadata);

    if (resource.status === CloudResourceStatus.RUNNING) {
      return this.toPublicStatus(resource);
    }

    const profile = (meta.profile || 'STANDARD') as ServerProvisionProfile;
    const plan = await this.resolveCurrentServerPlan(
      project.workspaceId,
      projectId,
      profile,
    );
    const capability = await this.probeCapability(project.workspaceId, plan.regionId);
    const gates = this.evaluateCreateGates(capability, plan);
    if (!gates.allReady) {
      throw new BadRequestException({
        message: gates.blockers[0] || '服务器创建前置条件未就绪',
        code: 'SERVER_PROVISION_GATE',
        gates,
      });
    }

    let operationId = String(meta.operationId || newServerOperationId());
    let createGeneration = Math.max(1, Number(meta.createGeneration || 1));
    let createGenerations = Array.isArray(meta.createGenerations)
      ? (meta.createGenerations as Meta[])
      : [];

    // Always archive current failure before a new attempt so UI cannot show stale Forbidden.RAM.
    let workingMeta = archiveServerProvisionCurrentFailure(meta) as Meta;

    if (!resource.providerResourceId && meta.runInstancesCompleted !== true) {
      const lastCode = String(meta.providerErrorCode || meta.lastErrorCode || '');
      if (/SoldOut|Zone\.NotEnoughResource|ZONE_CAPACITY|SOLD_OUT/i.test(lastCode)) {
        throw new BadRequestException({
          message:
            '当前规格/可用区售罄。请重新打开服务器方案查看新价格后，再次确认费用并创建（将使用新的创建世代）。',
          code: 'ECS_SOLD_OUT_REQUIRES_REPLAN',
          requiresReplan: true,
          requiresBillingReconfirm: true,
        });
      }
      if (/QuotaExceed|QUOTA_EXCEEDED/i.test(lastCode)) {
        throw new BadRequestException({
          message: '阿里云配额不足，请在控制台提升配额后再继续，不会自动重试创建。',
          code: 'ECS_QUOTA_EXCEEDED',
        });
      }

      const account = await this.requireAliyunAccount(project.workspaceId);
      const secrets = decryptProviderSecrets(account.credentialEncrypted!);
      const provisioner = new AlibabaCloudEcsProvisioner({
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region: resource.region || 'cn-hangzhou',
      });
      const instanceName = String(meta.instanceName || sanitizeEcsInstanceName(project.slug));
      const matches = await provisioner.reconcileManagedInstances({
        regionId: resource.region || 'cn-hangzhou',
        instanceName,
        cloudResourceId: resource.id,
      });
      if (matches.length > 1) {
        throw new BadRequestException({
          message: cloudEcsErrorUserMessage('RECONCILE_AMBIGUOUS'),
          code: 'ECS_RECONCILE_AMBIGUOUS',
        });
      }
      if (matches.length === 1) {
        await this.prisma.cloudResource.update({
          where: { id: resource.id },
          data: {
            providerResourceId: matches[0]!.instanceId,
            externalId: matches[0]!.instanceId,
            publicIp: matches[0]!.publicIp || null,
            status: CloudResourceStatus.CREATING,
            metadata: {
              ...workingMeta,
              runInstancesCompleted: true,
              reconciledFromProvider: true,
              phase: 'WAITING_INSTANCE',
              currentResolvedServerPlan: plan,
              resolvedSku: plan,
            } as Prisma.InputJsonObject,
          },
        });
      } else {
        if (
          pricesRequireReconfirmation(
            typeof meta.confirmedPriceFingerprint === 'string'
              ? meta.confirmedPriceFingerprint
              : null,
            {
              currency: plan.priceEstimate?.currency,
              tradePrice: plan.priceEstimate?.tradePrice,
              hourlyPrice: plan.priceEstimate?.hourlyPrice,
              instanceType: plan.instanceType,
            },
          )
        ) {
          throw new BadRequestException({
            message: '服务器报价已变化，请重新确认费用后再创建。',
            code: 'ECS_PRICE_CHANGED',
            previousFingerprint: meta.confirmedPriceFingerprint,
            currentPrice: plan.priceEstimate,
            requiresBillingReconfirm: true,
          });
        }

        const failureKind = classifyServerCreateFailureKind({
          errorCode: String(meta.lastErrorCode || ''),
          providerErrorCode: String(meta.providerErrorCode || ''),
          technicalMessage: String(meta.lastErrorMessage || ''),
        });
        const rotate = shouldRotateServerCreateClientToken({
          providerResourceId: resource.providerResourceId,
          createInstanceCompleted: meta.runInstancesCompleted === true,
          reconcileMatchCount: 0,
          failureKind,
          userRequestedRetry: true,
          runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
        });
        if (rotate.rotate) {
          const advanced = advanceServerCreateGeneration({
            generations: createGenerations as never,
            currentOperationId: operationId,
            totalAttemptCount: Number(meta.runInstancesAttemptCount || 0),
            totalSuccessCount: Number(meta.runInstancesSuccessCount || 0),
            terminalErrorCode: String(meta.providerErrorCode || meta.lastErrorCode || ''),
          });
          operationId = advanced.operationId;
          createGeneration = advanced.createGeneration;
          createGenerations = advanced.createGenerations as unknown as Meta[];
          workingMeta = {
            ...workingMeta,
            operationId,
            createGeneration,
            createGenerations,
            previousOperationId: advanced.previousOperationId,
            clientTokenRotateReason: rotate.reason,
            confirmedPriceFingerprint: serverPriceFingerprint({
              currency: plan.priceEstimate?.currency,
              tradePrice: plan.priceEstimate?.tradePrice,
              hourlyPrice: plan.priceEstimate?.hourlyPrice,
              instanceType: plan.instanceType,
            }),
          };
        }

        const queuedAt = new Date().toISOString();
        await this.prisma.cloudResource.update({
          where: { id: resource.id },
          data: {
            status: CloudResourceStatus.CREATING,
            metadata: {
              ...workingMeta,
              operationId,
              createGeneration,
              createGenerations,
              currentResolvedServerPlan: plan,
              resolvedSku: plan,
              phase: 'QUEUED',
              phases: [
                ...(Array.isArray(workingMeta.phases)
                  ? (workingMeta.phases as Meta[])
                  : []),
                { phase: 'QUEUED', at: queuedAt, status: 'running', resume: true },
              ],
              resumedAt: queuedAt,
            } as Prisma.InputJsonObject,
          },
        });
      }
    } else {
      const queuedAt = new Date().toISOString();
      await this.prisma.cloudResource.update({
        where: { id: resource.id },
        data: {
          status: CloudResourceStatus.CREATING,
          metadata: {
            ...workingMeta,
            phase: 'WAITING_INSTANCE',
            resumeMode: 'continue_existing',
            resumedAt: queuedAt,
          } as Prisma.InputJsonObject,
        },
      });
    }

    const latest = await this.requireProjectServer(projectId, id);
    const latestMeta = asMeta(latest.metadata);
    const op = String(latestMeta.operationId || operationId || newServerOperationId());
    const gen = Math.max(1, Number(latestMeta.createGeneration || createGeneration || 1));
    const queueBefore = await this.queue.getJobState(latest.id, gen);
    const enqueued = await this.queue.enqueue(latest.id, op, gen);
    // Re-read after enqueue so response is not a stale pre-worker snapshot
    const after = await this.requireProjectServer(projectId, id);
    const status = this.toPublicStatus(after);
    const queueAfter = await this.queue.getJobState(latest.id, gen);
    return {
      ...status,
      queueJobId: enqueued.jobId,
      queueJobState: queueAfter.state,
      queueJobStateBefore: enqueued.queueJobStateBefore ?? queueBefore.state,
      queueJobStateAfter: queueAfter.state,
      enqueueStrategy: enqueued.strategy,
      alreadyInProgress: enqueued.strategy === 'reuse_inflight',
      safeResume: enqueued.strategy !== 'reuse_inflight',
      currentErrorCleared: true,
      createGeneration: gen,
    };
  }

  async getStatus(userId: string, projectId: string, id: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const resource = await this.requireProjectServer(projectId, id);
    return this.toPublicStatus(resource);
  }

  async list(userId: string, projectId: string) {
    await this.workspaceAccess.requireProjectAccess(userId, projectId);
    const rows = await this.prisma.cloudResource.findMany({
      where: { projectId, type: CloudResourceType.SERVER },
      orderBy: { createdAt: 'desc' },
    });
    return { resources: rows.map((r) => this.toPublicStatus(r)) };
  }

  async destroy(
    userId: string,
    projectId: string,
    id: string,
    body: { confirmDestroy?: boolean },
  ) {
    const { membership, project } = await this.workspaceAccess.requireProjectAccess(
      userId,
      projectId,
    );
    this.requireWrite(membership.role);
    if (!body.confirmDestroy) {
      throw new BadRequestException('释放服务器会永久删除这台云服务器。请确认后继续。');
    }
    const resource = await this.requireProjectServer(projectId, id);
    if (!resource.providerResourceId) {
      await this.prisma.cloudResource.update({
        where: { id },
        data: { status: CloudResourceStatus.DELETED },
      });
      return { ok: true, deleted: false, message: '未创建云实例，已标记删除。' };
    }
    const account = await this.requireAliyunAccount(project.workspaceId);
    const secrets = decryptProviderSecrets(account.credentialEncrypted!);
    const provisioner = new AlibabaCloudEcsProvisioner({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region: resource.region || 'cn-hangzhou',
    });
    await provisioner.deleteInstance(resource.providerResourceId);
    await this.prisma.cloudResource.update({
      where: { id },
      data: {
        status: CloudResourceStatus.DELETED,
        metadata: {
          ...asMeta(resource.metadata),
          deletedAt: new Date().toISOString(),
        } as Prisma.InputJsonObject,
      },
    });
    return { ok: true, deleted: true, message: '云服务器已释放。' };
  }

  // --- internals ---

  private evaluateCreateGates(
    capability: Awaited<ReturnType<AlibabaCloudCapabilityService['probe']>> | null,
    plan: ResolvedServerPlan,
  ) {
    const actions = capability?.capabilities.ecs?.actions;
    const blockers: string[] = [];
    const ecsRead = actions?.read === 'READY';
    const instanceCreate = actions?.instanceCreate === 'READY';
    const securityGroupRead = actions?.securityGroupRead === 'READY';
    const securityGroupCreate = actions?.securityGroupCreate === 'READY';
    const securityGroupAuthorize = actions?.securityGroupAuthorize === 'READY';
    const imageReadStatus = actions?.imageRead || null;
    const imageRead = imageReadStatus === 'READY';
    const ecsCreate =
      instanceCreate && securityGroupCreate && securityGroupAuthorize;
    const ecsNetwork =
      actions?.network === 'READY' && securityGroupRead;
    const ecsPrice = actions?.price === 'READY';
    const vpcRead = capability?.capabilities.vpc?.status === 'READY';
    const billingReady =
      capability?.BILLING_ORDER_PERMISSION === 'READY' ||
      capability?.capabilities.billing?.actions?.order === 'READY';
    const accountBalance = capability?.capabilities.billing?.actions?.accountBalance;
    const balanceBlocksCreate = accountBalance === 'INSUFFICIENT';

    if (!ecsRead) blockers.push('ECS 读取权限未就绪');
    if (!vpcRead) blockers.push('VPC 读取权限未就绪');
    if (!securityGroupRead) blockers.push('安全组读取权限未就绪');
    if (!securityGroupCreate) blockers.push('安全组创建权限未就绪');
    if (!securityGroupAuthorize) blockers.push('安全组授权权限未就绪');
    if (!instanceCreate) blockers.push('ECS RunInstances 权限未就绪');
    if (!imageRead) blockers.push('ecs:DescribeImages');
    if (!ecsPrice) blockers.push('ECS 询价权限未就绪');
    if (!billingReady) blockers.push('订单/支付权限未就绪');
    if (balanceBlocksCreate) blockers.push('BILLING_NOT_ENOUGH_BALANCE');
    if (!plan.instanceType) blockers.push('规格未就绪');
    if (!plan.priceEstimate?.hourlyPrice && !plan.priceEstimate?.tradePrice) {
      blockers.push('真实询价未就绪');
    }
    // imageReady = resolved imageId only; does NOT imply ecs.imageRead READY.
    if (!plan.imageId) blockers.push('系统镜像未就绪');
    if (!plan.regionId) blockers.push('地域未就绪');

    return {
      ecsRead,
      ecsCreate,
      ecsNetwork,
      ecsPrice,
      instanceCreate,
      securityGroupRead,
      securityGroupCreate,
      securityGroupAuthorize,
      imageRead,
      vpcRead,
      billingReady,
      billingAccountBalance: accountBalance || 'UNKNOWN',
      skuReady: Boolean(plan.instanceType),
      priceReady: Boolean(plan.priceEstimate?.hourlyPrice || plan.priceEstimate?.tradePrice),
      imageReady: Boolean(plan.imageId),
      networkReady: true,
      blockers,
      allReady: blockers.length === 0,
    };
  }

  private async previewSecurityGroupPlan(
    workspaceId: string,
    regionId: string,
    vpcId: string | null,
  ) {
    const allowedPorts = [...ECS_PUBLIC_INGRESS_PORTS];
    const deniedPublicPorts = [...ECS_DENIED_PUBLIC_PORT_RANGES];
    const base = {
      allowedPorts,
      deniedPublicPorts,
      note: 'securityGroupId 在 dry-run 可为空；真实创建于 PREPARING_SECURITY_GROUP 调用 ensureSecurityGroup() 后再传给 RunInstances。',
    };
    try {
      const account = await this.requireAliyunAccount(workspaceId);
      const secrets = decryptProviderSecrets(account.credentialEncrypted!);
      const provisioner = new AlibabaCloudEcsProvisioner({
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region: regionId,
      });
      const preview = await provisioner.previewSecurityGroup(regionId, vpcId);
      return { ...base, ...preview };
    } catch (error) {
      const message = String((error as Error)?.message || error);
      const permission =
        /forbidden|notauthorized|no permission|无权/i.test(message);
      return {
        ...base,
        mode: permission ? ('READ_DENIED' as const) : ('CREATE' as const),
        securityGroupId: null,
        describeError: permission ? 'DescribeSecurityGroups' : 'UNKNOWN',
      };
    }
  }

  private async getResumeHint(projectId: string) {
    const failed = await this.prisma.cloudResource.findFirst({
      where: { projectId, type: CloudResourceType.SERVER, status: CloudResourceStatus.FAILED },
      orderBy: { updatedAt: 'desc' },
    });
    if (!failed) {
      return {
        resumeCloudResourceId: null,
        createGeneration: null,
        queueJobState: null,
        currentErrorCleared: null,
        providerResourceId: null,
        runInstancesAttemptCount: 0,
      };
    }
    const meta = asMeta(failed.metadata);
    const gen = Math.max(1, Number(meta.createGeneration || 1));
    const queueJob = await this.queue.getJobState(failed.id, gen);
    return {
      resumeCloudResourceId: failed.id,
      createGeneration: gen,
      queueJobState: queueJob.state,
      queueJobId: queueJob.jobId,
      currentErrorCleared: meta.currentErrorCleared === true,
      providerResourceId: failed.providerResourceId,
      runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
      lastFailure: meta.lastFailure || null,
      errorHistoryCount: Array.isArray(meta.errorHistory) ? meta.errorHistory.length : 0,
    };
  }

  private async resolveCurrentServerPlan(
    workspaceId: string,
    projectId: string,
    profile: ServerProvisionProfile,
  ): Promise<ResolvedServerPlan> {
    const account = await this.requireAliyunAccount(workspaceId);
    const secrets = decryptProviderSecrets(account.credentialEncrypted!);
    const dependencyRegions = await this.collectDependencyRegions(projectId);
    const regionPick = pickRegionFromHints({
      dependencyRegions,
      providerAccountRegion: account.region,
      defaultRegion: 'cn-hangzhou',
    });
    const planner = new AlibabaCloudEcsPlanner({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region: regionPick.regionId,
    });
    const preferredVpc = await this.findDependencyVpc(projectId);
    const placement = await planner.resolvePlacement({
      regionId: regionPick.regionId,
      preferredVpcId: preferredVpc.vpcId,
      preferredZoneId: preferredVpc.zoneId,
    });
    const sku = await planner.resolveServerSku(profile, {
      regionId: regionPick.regionId,
      zoneId: placement.zoneId,
    });
    if (!sku) {
      throw new BadRequestException({
        message: '当前地域暂无满足该档位的可售规格',
        code: 'ECS_SKU_UNAVAILABLE',
      });
    }
    const image = await planner.recommendImage(regionPick.regionId);
    if (!image?.imageId) {
      throw new BadRequestException({
        message: cloudEcsErrorUserMessage('IMAGE_UNAVAILABLE'),
        code: 'IMAGE_UNAVAILABLE',
      });
    }
    const price = await planner.getPriceEstimate({
      regionId: regionPick.regionId,
      instanceType: sku.instanceType,
      systemDiskGb: sku.systemDiskGb,
    });
    const def = SERVER_RESOURCE_PROFILES[profile];
    return {
      profile,
      regionId: regionPick.regionId,
      zoneId: placement.zoneId || sku.zoneId,
      instanceType: sku.instanceType,
      cpu: sku.cpu,
      memoryGb: sku.memoryGb,
      systemDiskGb: def.systemDiskGb,
      systemDiskCategory: 'cloud_essd',
      imageId: image.imageId,
      imageName: image.osName,
      vpcId: placement.vpcId || preferredVpc.vpcId,
      vSwitchId: placement.vSwitchId || preferredVpc.vSwitchId,
      securityGroupId: null,
      publicIpRequired: true,
      chargeType: 'PostPaid',
      priceEstimate: price.available
        ? {
            currency: price.currency,
            originalPrice: price.originalPrice,
            tradePrice: price.tradePrice,
            hourlyPrice: price.hourlyPrice,
            monthlyEquivalent: price.monthlyEquivalent,
            priceUnit: 'Hour',
            providerRequestId: price.providerRequestId || null,
            checkedAt: price.checkedAt,
          }
        : null,
      selectionReason: sku.selectionReason,
      availabilityFingerprint: `${regionPick.regionId}:${sku.instanceType}:${placement.zoneId || ''}`,
    };
  }

  private async probeCapability(workspaceId: string, region: string) {
    const account = await this.requireAliyunAccount(workspaceId);
    const secrets = decryptProviderSecrets(account.credentialEncrypted!);
    return new AlibabaCloudCapabilityService().probe(
      {
        accessKey: secrets.accessKey,
        secretKey: secrets.secretKey,
        region,
      },
      { skipCreateDryRuns: true },
    );
  }

  private toPublicStatus(resource: {
    id: string;
    status: CloudResourceStatus;
    region: string | null;
    publicIp: string | null;
    providerResourceId: string | null;
    instanceType: string | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  }) {
    const meta = asMeta(resource.metadata);
    const phase = String(meta.phase || '') as ServerProvisionPhase;
    const plan = (meta.currentResolvedServerPlan || meta.resolvedSku || null) as
      | ResolvedServerPlan
      | null;
    const hasInstance = Boolean(resource.providerResourceId);
    return {
      id: resource.id,
      cloudResourceId: resource.id,
      status: resource.status,
      phase,
      phaseLabel: mapServerPhaseToProductLabel(phase),
      productPhaseLabel: SERVER_PROVISION_PHASE_LABELS[phase] || phase,
      region: resource.region,
      publicIp: resource.publicIp,
      privateIp: typeof meta.privateIp === 'string' ? meta.privateIp : null,
      providerResourceId: resource.providerResourceId,
      instanceType: resource.instanceType || plan?.instanceType || null,
      profile: meta.profile || plan?.profile || null,
      profileLabel:
        SERVER_PROFILE_LABELS[(meta.profile as ServerProvisionProfile) || 'STANDARD'] || null,
      serverReadiness:
        resource.status === CloudResourceStatus.RUNNING
          ? 'READY_FOR_INITIALIZATION'
          : resource.status === CloudResourceStatus.CREATING
            ? 'CREATING'
            : resource.status === CloudResourceStatus.FAILED
              ? 'ERROR'
              : 'NOT_CONFIGURED',
      serverReadinessLabel:
        resource.status === CloudResourceStatus.RUNNING
          ? '服务器已创建，等待初始化'
          : resource.status === CloudResourceStatus.CREATING
            ? '正在创建'
            : resource.status === CloudResourceStatus.FAILED
              ? typeof meta.lastErrorUserMessage === 'string' && meta.lastErrorUserMessage
                ? meta.lastErrorUserMessage
                : '创建失败'
              : '未配置',
      billingNotice:
        resource.status === CloudResourceStatus.RUNNING
          ? '这台服务器正在产生阿里云费用。'
          : null,
      retryActionLabel: hasInstance ? '继续完成服务器配置' : '重新尝试创建服务器',
      failedPhase: typeof meta.failedPhase === 'string' ? meta.failedPhase : null,
      failedPhaseLabel: mapServerPhaseToProductLabel(
        typeof meta.failedPhase === 'string' ? meta.failedPhase : null,
      ),
      failedOperation: typeof meta.failedOperation === 'string' ? meta.failedOperation : null,
      providerErrorCode: typeof meta.providerErrorCode === 'string' ? meta.providerErrorCode : null,
      providerRequestId: typeof meta.lastRequestId === 'string' ? meta.lastRequestId : null,
      httpStatus: typeof meta.httpStatus === 'number' ? meta.httpStatus : null,
      failedAt: typeof meta.failedAt === 'string' ? meta.failedAt : null,
      productSteps: SERVER_PROVISION_PRODUCT_STEPS.map((step) => {
        const seen = Array.isArray(meta.phases)
          ? (meta.phases as Array<{ phase?: string }>).some((p) => p.phase === step.phase)
          : false;
        const failed = meta.failedPhase === step.phase;
        return {
          phase: step.phase,
          label: step.label,
          reached: seen,
          failed,
        };
      }),
      priceEstimate: plan?.priceEstimate || null,
      runInstancesAttemptCount: Number(meta.runInstancesAttemptCount || 0),
      runInstancesSuccessCount: Number(meta.runInstancesSuccessCount || 0),
      createGeneration: Number(meta.createGeneration || 1),
      serverInstanceId: typeof meta.serverInstanceId === 'string' ? meta.serverInstanceId : null,
      errorCode: typeof meta.lastErrorCode === 'string' ? meta.lastErrorCode : null,
      errorMessage:
        typeof meta.lastErrorUserMessage === 'string' ? meta.lastErrorUserMessage : null,
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    };
  }

  private async requireProjectServer(projectId: string, id: string) {
    const resource = await this.prisma.cloudResource.findFirst({
      where: { id, projectId, type: CloudResourceType.SERVER },
    });
    if (!resource) {
      throw new BadRequestException('服务器开通记录不存在');
    }
    return resource;
  }

  private async requireAliyunAccount(workspaceId: string) {
    const existing = await this.prisma.providerAccount.findFirst({
      where: {
        workspaceId,
        status: 'ACTIVE',
        provider: { type: ALIYUN_PROVIDER_TYPE },
      },
      include: { provider: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!existing?.credentialEncrypted) {
      throw new BadRequestException({
        message: '请先配置阿里云云资源账户（ProviderAccount ALIYUN）',
        code: 'ALIYUN_ACCOUNT_MISSING',
      });
    }
    return existing;
  }

  private async collectDependencyRegions(projectId: string): Promise<string[]> {
    const rows = await this.prisma.cloudResource.findMany({
      where: {
        projectId,
        type: { in: [CloudResourceType.DATABASE, CloudResourceType.CACHE] },
        status: { notIn: [CloudResourceStatus.DELETED] },
        region: { not: null },
      },
      select: { region: true },
    });
    return rows.map((r) => r.region!).filter(Boolean);
  }

  private async findDependencyVpc(projectId: string) {
    const rows = await this.prisma.cloudResource.findMany({
      where: {
        projectId,
        type: { in: [CloudResourceType.DATABASE, CloudResourceType.CACHE] },
        status: { notIn: [CloudResourceStatus.DELETED] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 10,
    });
    for (const row of rows) {
      const meta = asMeta(row.metadata);
      const vpcId =
        (typeof meta.vpcId === 'string' && meta.vpcId) ||
        (typeof meta.VpcId === 'string' && meta.VpcId) ||
        null;
      const vSwitchId =
        (typeof meta.vSwitchId === 'string' && meta.vSwitchId) ||
        (typeof meta.VSwitchId === 'string' && meta.VSwitchId) ||
        null;
      const zoneId =
        (typeof meta.zoneId === 'string' && meta.zoneId) ||
        (typeof meta.ZoneId === 'string' && meta.ZoneId) ||
        null;
      if (vpcId) return { vpcId, vSwitchId, zoneId };
    }
    return { vpcId: null as string | null, vSwitchId: null as string | null, zoneId: null as string | null };
  }

  private requireWrite(role: WorkspaceRole) {
    if (!WRITE_ROLES.includes(role)) {
      throw new ForbiddenException('仅管理员可以创建云服务器');
    }
  }
}

function asMeta(value: unknown): Meta {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Meta;
  }
  return {};
}

function actionsReadiness(
  capability: {
    capabilities?: {
      ecs?: { actions?: Record<string, string | undefined> };
    };
  } | null,
  key: string,
): string | null {
  return capability?.capabilities?.ecs?.actions?.[key] || null;
}
