/**
 * Step 26.2 — Aliyun ECS provision worker.
 * Creates ECS + ServerInstance. Does NOT install Docker / SSH software setup.
 */
import {
  CloudResourceStatus,
  PrismaClient,
  type Prisma,
} from '@launchos/database';
import { AlibabaCloudEcsProvisioner } from '@launchos/providers';
import {
  buildLaunchosEcsTags,
  bumpServerCreateGenerationCounters,
  classifyCloudEcsError,
  classifyServerCreateFailureKind,
  cloudEcsErrorUserMessage,
  decryptCredential,
  extractAliyunSdkErrorFields,
  inferEcsFailedOperationFromPhase,
  isServerProvisionSilentlyIncomplete,
  isServerProvisionTerminalNoAutoRetry,
  parseMissingParameterName,
  peekCurrentServerCreateGeneration,
  validateRunInstancesRequestPreflight,
  withRedisLock,
  type ResolvedServerPlan,
  type ServerProvisionPhase,
} from '@launchos/shared';
import { UnrecoverableError } from 'bullmq';

type Meta = Record<string, unknown>;
const TOTAL_TIMEOUT_MS = 25 * 60_000;

/**
 * Explicit test-only hooks. Must be passed by the test harness directly.
 * Never read from CloudResource.metadata, job.data, env, or NODE_ENV.
 */
export type ServerProvisionTestOnlyHooks = {
  /**
   * Optional provisioner override (mock). Production Worker never sets this.
   */
  provisioner?: AlibabaCloudEcsProvisioner;
  /**
   * After CREATING_INSTANCE + preflight + attempt++ persistence, skip SDK
   * RunInstances and throw MOCK_ABORT_BEFORE_RUN_INSTANCES.
   */
  abortBeforeSdkRunInstances?: boolean;
};

export async function executeServerProvision(
  prisma: PrismaClient,
  cloudResourceId: string,
  testOnly?: ServerProvisionTestOnlyHooks,
): Promise<void> {
  const started = Date.now();
  const resource = await prisma.cloudResource.findUnique({
    where: { id: cloudResourceId },
    include: { provider: true },
  });
  if (!resource || !resource.projectId) {
    throw new Error('cloud resource missing');
  }
  if (resource.status === CloudResourceStatus.RUNNING && resource.providerResourceId) {
    // Ensure ServerInstance exists then exit
    await ensureServerInstance(prisma, resource);
    return;
  }

  const meta = asMeta(resource.metadata);
  const passwordEncrypted = String(meta.passwordEncrypted || '');
  if (!passwordEncrypted) {
    throw new Error('managed ecs password missing');
  }
  const password = decryptCredential(passwordEncrypted);
  const plan = (meta.currentResolvedServerPlan || meta.resolvedSku) as ResolvedServerPlan | null;
  if (!plan?.instanceType || !plan.imageId || !plan.regionId) {
    throw new Error('CloudResource missing currentResolvedServerPlan');
  }
  const operationId = String(meta.operationId || cloudResourceId);
  const instanceName = String(meta.instanceName || `launchos-${cloudResourceId.slice(-8)}`);
  const region = resource.region || plan.regionId;

  let provisioner: AlibabaCloudEcsProvisioner;
  if (testOnly?.provisioner) {
    provisioner = testOnly.provisioner;
  } else {
    const account = await prisma.providerAccount.findFirst({
      where: {
        workspaceId: resource.workspaceId,
        providerId: resource.providerId,
        status: 'ACTIVE',
        provider: { type: 'ALIYUN' },
      },
      include: { provider: true },
    });
    if (!account?.credentialEncrypted || account.provider.type !== 'ALIYUN') {
      throw new Error('Aliyun provider account missing');
    }
    const secrets = decryptProviderSecretsLocal(account.credentialEncrypted);
    provisioner = new AlibabaCloudEcsProvisioner({
      accessKey: secrets.accessKey,
      secretKey: secrets.secretKey,
      region,
    });
  }

  const updatePhase = async (phase: ServerProvisionPhase, patch: Meta = {}) => {
    const latest = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
    const current = asMeta(latest?.metadata);
    const phases = Array.isArray(current.phases) ? [...(current.phases as Meta[])] : [];
    phases.push({ phase, at: new Date().toISOString(), status: 'running' });
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.CREATING,
        metadata: {
          ...current,
          ...patch,
          phase,
          phases,
          passwordEncrypted: current.passwordEncrypted || passwordEncrypted,
        } as Prisma.InputJsonObject,
      },
    });
  };

  try {
    if (Date.now() - started > TOTAL_TIMEOUT_MS) {
      throw new Error('Timed out provisioning ECS');
    }

    const lockResult = await withRedisLock(
      `ecs-create:${cloudResourceId}`,
      120_000,
      async (): Promise<'continue_after_create'> => {
        const locked = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
        if (!locked) throw new Error('cloud resource missing');
        const lockedMeta = asMeta(locked.metadata);

        // Re-check inside lock
        if (locked.providerResourceId?.trim() || lockedMeta.runInstancesCompleted === true) {
          return 'continue_after_create';
        }

        await updatePhase('RECONCILING');
        const matches = await withFailedOperation('DescribeInstances', () =>
          provisioner.reconcileManagedInstances({
            regionId: region,
            instanceName,
            cloudResourceId,
          }),
        );
        if (matches.length > 1) {
          throw Object.assign(new Error(cloudEcsErrorUserMessage('RECONCILE_AMBIGUOUS')), {
            code: 'ECS_RECONCILE_AMBIGUOUS',
            failedOperation: 'DescribeInstances',
          });
        }
        if (matches.length === 1) {
          await prisma.cloudResource.update({
            where: { id: cloudResourceId },
            data: {
              providerResourceId: matches[0]!.instanceId,
              externalId: matches[0]!.instanceId,
              publicIp: matches[0]!.publicIp || null,
              metadata: {
                ...lockedMeta,
                runInstancesCompleted: true,
                reconciledFromProvider: true,
                phase: 'WAITING_INSTANCE',
              } as Prisma.InputJsonObject,
            },
          });
          return 'continue_after_create';
        }

        await updatePhase('PREPARING_NETWORK');
        const network = await withFailedOperation('DescribeVpcs/DescribeVSwitches', () =>
          provisioner.ensureNetwork({
            regionId: region,
            preferredVpcId: plan.vpcId,
            preferredVSwitchId: plan.vSwitchId,
          }),
        );

        await updatePhase('PREPARING_SECURITY_GROUP', {
          vpcId: network.vpcId,
          vSwitchId: network.vSwitchId,
          zoneId: network.zoneId || plan.zoneId,
        });

        const securityGroupId = await withFailedOperation('EnsureSecurityGroup', () =>
          provisioner.ensureSecurityGroup(region, network.vpcId),
        );

        await withFailedOperation('DescribeImages', () =>
          provisioner.assertImageAvailable(region, plan.imageId),
        );

        const tags = buildLaunchosEcsTags({
          cloudResourceId,
          projectId: resource.projectId!,
          workspaceId: resource.workspaceId,
        });
        const clientToken = operationId.slice(0, 64);

        // Fresh read before RunInstances
        const beforeCreate = await prisma.cloudResource.findUnique({
          where: { id: cloudResourceId },
        });
        const beforeMeta = asMeta(beforeCreate?.metadata);
        if (beforeCreate?.providerResourceId?.trim() || beforeMeta.runInstancesCompleted === true) {
          return 'continue_after_create';
        }

        await updatePhase('CREATING_INSTANCE', {
          securityGroupId,
          vpcId: network.vpcId,
          vSwitchId: network.vSwitchId,
        });

        const preflight = validateRunInstancesRequestPreflight({
          regionId: region,
          zoneId: network.zoneId || plan.zoneId,
          instanceType: plan.instanceType,
          imageId: plan.imageId,
          systemDiskCategory: plan.systemDiskCategory || 'cloud_essd',
          systemDiskSize: plan.systemDiskGb,
          vSwitchId: network.vSwitchId,
          securityGroupId,
          instanceName,
          chargeType: 'PostPaid',
          internetChargeType: 'PayByTraffic',
          internetMaxBandwidthOut: 5,
          clientToken,
          loginMode: 'PASSWORD',
          passwordPresent: Boolean(password),
          passwordLength: password ? password.length : 0,
          tags,
        });
        await prisma.cloudResource.update({
          where: { id: cloudResourceId },
          data: {
            metadata: {
              ...asMeta(
                (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))
                  ?.metadata,
              ),
              securityGroupId,
              vpcId: network.vpcId,
              vSwitchId: network.vSwitchId,
              zoneId: network.zoneId || plan.zoneId,
              resolvedRunInstancesRequest: preflight.resolvedRunInstancesRequest,
              runInstancesRequestValid: preflight.valid,
              runInstancesMissingFields: preflight.missingFields,
              phase: 'CREATING_INSTANCE',
            } as Prisma.InputJsonObject,
          },
        });
        if (!preflight.valid) {
          throw Object.assign(
            new Error(
              `RUN_INSTANCES_REQUEST_INVALID missing=${preflight.missingFields.join(',')}`,
            ),
            {
              code: 'RUN_INSTANCES_REQUEST_INVALID',
              failedOperation: 'BUILD_RUN_INSTANCES_REQUEST',
              failedPhase: 'CREATING_INSTANCE',
              missingFields: preflight.missingFields,
            },
          );
        }

        // Same generation: at most one real RunInstances (prevents BullMQ / executor retry loops).
        const currentGen = peekCurrentServerCreateGeneration(
          Array.isArray(beforeMeta.createGenerations)
            ? (beforeMeta.createGenerations as never)
            : [],
        );
        if (Number(currentGen?.attemptCount || 0) >= 1) {
          throw new UnrecoverableError(
            'ECS_RUNINSTANCES_ALREADY_ATTEMPTED_THIS_GENERATION: terminal errors must not auto-retry RunInstances in the same generation',
          );
        }

        // Attempt counter: only after local validation passes, immediately before SDK call.
        const attemptCount = Number(beforeMeta.runInstancesAttemptCount || 0) + 1;
        const generations = bumpServerCreateGenerationCounters(
          Array.isArray(beforeMeta.createGenerations)
            ? (beforeMeta.createGenerations as never)
            : [],
          { attemptDelta: 1 },
        );
        await prisma.cloudResource.update({
          where: { id: cloudResourceId },
          data: {
            metadata: {
              ...asMeta(
                (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))
                  ?.metadata,
              ),
              runInstancesAttemptCount: attemptCount,
              createGenerations: generations,
              generationAttemptCount: Number(beforeMeta.generationAttemptCount || 0) + 1,
              phase: 'CREATING_INSTANCE',
            } as Prisma.InputJsonObject,
          },
        });

        // Test-only: never triggered by metadata / job.data / env.
        if (testOnly?.abortBeforeSdkRunInstances === true) {
          throw Object.assign(new Error('MOCK_ABORT_BEFORE_RUN_INSTANCES'), {
            code: 'MOCK_ABORT_BEFORE_RUN_INSTANCES',
            failedOperation: 'MOCK_ABORT_BEFORE_RUN_INSTANCES',
            failedPhase: 'CREATING_INSTANCE',
          });
        }

        try {
          const created = await withFailedOperation('RunInstances', () =>
            provisioner.runInstance({
              regionId: region,
              imageId: plan.imageId,
              instanceType: plan.instanceType,
              securityGroupId,
              vSwitchId: network.vSwitchId,
              instanceName,
              password,
              systemDiskGb: plan.systemDiskGb,
              systemDiskCategory: plan.systemDiskCategory || 'cloud_essd',
              clientToken,
              tags,
            }),
          );

          // Persist immediately
          const successGens = bumpServerCreateGenerationCounters(generations, {
            successDelta: 1,
          });
          await prisma.cloudResource.update({
            where: { id: cloudResourceId },
            data: {
              providerResourceId: created.instanceId,
              externalId: created.instanceId,
              metadata: {
                ...asMeta(
                  (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))
                    ?.metadata,
                ),
                runInstancesCompleted: true,
                runInstancesSuccessCount:
                  Number(beforeMeta.runInstancesSuccessCount || 0) + 1,
                generationSuccessCount: Number(beforeMeta.generationSuccessCount || 0) + 1,
                createGenerations: successGens,
                lastRequestId: created.requestId,
                phase: 'WAITING_INSTANCE',
              } as Prisma.InputJsonObject,
            },
          });
          return 'continue_after_create';
        } catch (error) {
          const sdk = extractAliyunSdkErrorFields(error);
          const ecsCode = classifyCloudEcsError(error);
          const kind = classifyServerCreateFailureKind({
            errorCode: ecsCode,
            providerErrorCode: sdk.code,
            technicalMessage: sdk.message,
            httpStatus: sdk.statusCode,
          });
          const latestMeta = asMeta(
            (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
          );
          const noAutoRetry = isServerProvisionTerminalNoAutoRetry({
            errorCode: ecsCode,
            providerErrorCode: sdk.code,
            technicalMessage: sdk.message,
            failureKind: kind,
            httpStatus: sdk.statusCode,
          });

          // Timeout / UNKNOWN_RESULT: reconcile first — never treat as "failed create → new RunInstances"
          if (kind === 'UNKNOWN_RESULT') {
            const afterTimeout = await provisioner.reconcileManagedInstances({
              regionId: region,
              instanceName,
              cloudResourceId,
            });
            if (afterTimeout.length > 1) {
              throw Object.assign(new Error(cloudEcsErrorUserMessage('RECONCILE_AMBIGUOUS')), {
                code: 'ECS_RECONCILE_AMBIGUOUS',
              });
            }
            if (afterTimeout.length === 1) {
              const successGens = bumpServerCreateGenerationCounters(
                Array.isArray(latestMeta.createGenerations)
                  ? (latestMeta.createGenerations as never)
                  : [],
                { successDelta: 1 },
              );
              await prisma.cloudResource.update({
                where: { id: cloudResourceId },
                data: {
                  providerResourceId: afterTimeout[0]!.instanceId,
                  externalId: afterTimeout[0]!.instanceId,
                  publicIp: afterTimeout[0]!.publicIp || null,
                  status: CloudResourceStatus.CREATING,
                  metadata: {
                    ...latestMeta,
                    runInstancesCompleted: true,
                    reconciledFromProvider: true,
                    reconciledSuccess: true,
                    createFailureKind: kind,
                    lastErrorCode: ecsCode,
                    providerErrorCode: sdk.code,
                    lastErrorMessage: sdk.message,
                    lastRequestId: sdk.requestId,
                    runInstancesSuccessCount:
                      Number(latestMeta.runInstancesSuccessCount || 0) + 1,
                    generationSuccessCount:
                      Number(latestMeta.generationSuccessCount || 0) + 1,
                    createGenerations: successGens,
                    phase: 'WAITING_INSTANCE',
                  } as Prisma.InputJsonObject,
                },
              });
              return 'continue_after_create';
            }
            // 0 matches: keep same generation / ClientToken; mark FAILED for resume (no rotate)
            await prisma.cloudResource.update({
              where: { id: cloudResourceId },
              data: {
                status: CloudResourceStatus.FAILED,
                metadata: {
                  ...latestMeta,
                  createFailureKind: kind,
                  lastErrorCode: ecsCode,
                  providerErrorCode: sdk.code,
                  lastErrorMessage: sdk.message,
                  lastErrorUserMessage:
                    '创建结果未知，已保留 ClientToken，继续前将先核对阿里云侧实例。',
                  lastRequestId: sdk.requestId,
                  phase: 'FAILED',
                } as Prisma.InputJsonObject,
              },
            });
            throw error;
          }

          const billingAccountBalance =
            ecsCode === 'BILLING_NOT_ENOUGH_BALANCE' || ecsCode === 'BILLING_INSUFFICIENT'
              ? 'INSUFFICIENT'
              : latestMeta.billingAccountBalance;

          await prisma.cloudResource.update({
            where: { id: cloudResourceId },
            data: {
              status: CloudResourceStatus.FAILED,
              metadata: {
                ...latestMeta,
                createFailureKind: kind,
                lastErrorCode: ecsCode,
                errorCategory:
                  ecsCode === 'BILLING_NOT_ENOUGH_BALANCE' || ecsCode === 'BILLING_INSUFFICIENT'
                    ? 'BILLING_NOT_ENOUGH_BALANCE'
                    : latestMeta.errorCategory || null,
                providerErrorCode: sdk.code,
                lastErrorMessage: sdk.message,
                lastErrorUserMessage: cloudEcsErrorUserMessage(ecsCode, 'RunInstances'),
                lastRequestId: sdk.requestId,
                httpStatus: sdk.statusCode ?? latestMeta.httpStatus ?? null,
                failedOperation: 'RunInstances',
                phase: 'FAILED',
                billingAccountBalance,
                requiresUserAction: noAutoRetry,
                autoRetryBlocked: noAutoRetry,
              } as Prisma.InputJsonObject,
            },
          });
          if (noAutoRetry) {
            throw new UnrecoverableError(
              sdk.message ||
                (error instanceof Error ? error.message : String(error)) ||
                String(sdk.code || ecsCode),
            );
          }
          throw error;
        }
        // Must not complete the lock successfully without an instance id.
        throw Object.assign(new Error('SERVER_PROVISION_INCOMPLETE'), {
          code: 'SERVER_PROVISION_INCOMPLETE',
          failedOperation: 'SERVER_PROVISION_INCOMPLETE',
          failedPhase: 'CREATING_INSTANCE',
        });
      },
    );

    void lockResult;

    // After lock: wait Running + public IP + bind ServerInstance
    const current = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
    const providerResourceId = current?.providerResourceId?.trim() || '';
    if (!current || !providerResourceId) {
      await failIfSilentlyIncomplete(prisma, cloudResourceId);
      throw Object.assign(new Error('SERVER_PROVISION_INCOMPLETE'), {
        code: 'SERVER_PROVISION_INCOMPLETE',
        failedOperation: 'SERVER_PROVISION_INCOMPLETE',
        failedPhase: String(asMeta(current?.metadata).phase || 'CREATING_INSTANCE'),
      });
    }

    await updatePhase('WAITING_INSTANCE');
    await updatePhase('ALLOCATING_PUBLIC_IP');
    const ready = await withFailedOperation('DescribeInstances/AllocatePublicIpAddress', () =>
      provisioner.waitUntilRunning(providerResourceId, region),
    );
    if (!ready.publicIp) {
      throw Object.assign(new Error(cloudEcsErrorUserMessage('PUBLIC_IP_MISSING')), {
        code: 'PUBLIC_IP_MISSING',
      });
    }

    await updatePhase('VERIFYING_INSTANCE', {
      privateIp: ready.privateIp,
    });
    await updatePhase('BINDING');

    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.RUNNING,
        publicIp: ready.publicIp,
        instanceType: ready.instanceType || plan.instanceType,
        metadata: {
          ...asMeta(
            (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
          ),
          phase: 'DONE',
          privateIp: ready.privateIp,
          publicIp: ready.publicIp,
          serverReadiness: 'READY_FOR_INITIALIZATION',
          billingNotice: '这台服务器正在产生阿里云费用。',
        } as Prisma.InputJsonObject,
      },
    });

    const bound = await ensureServerInstance(prisma, {
      id: current.id,
      workspaceId: current.workspaceId,
      projectId: current.projectId,
      publicIp: ready.publicIp,
      providerResourceId,
      region,
      metadata: current.metadata,
    });
    if (bound) {
      const latestMeta = asMeta(
        (await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } }))?.metadata,
      );
      await prisma.cloudResource.update({
        where: { id: cloudResourceId },
        data: {
          metadata: {
            ...latestMeta,
            serverInstanceId: bound.id,
            phase: 'DONE',
            fixtureStopBeforeRunInstances: null,
            fixtureStopReached: null,
            fixtureStopAt: null,
            fixtureNote: null,
          } as Prisma.InputJsonObject,
        },
      });
    }

    // Final guard: never leave BullMQ completed with mid-flight CREATING.
    await failIfSilentlyIncomplete(prisma, cloudResourceId);
  } catch (error) {
    const latest = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
    if (latest?.status === CloudResourceStatus.RUNNING) throw error;
    const sdk = extractAliyunSdkErrorFields(error);
    const technicalMessage =
      sdk.message || (error instanceof Error ? error.message : String(error));
    const code = classifyCloudEcsError(error);
    const latestMeta = asMeta(latest?.metadata);
    const explicitFailedPhase =
      error && typeof error === 'object' && 'failedPhase' in error
        ? String((error as { failedPhase?: unknown }).failedPhase || '')
        : '';
    const failedPhase =
      explicitFailedPhase ||
      (typeof latestMeta.phase === 'string' && latestMeta.phase !== 'FAILED'
        ? latestMeta.phase
        : null);
    const failedOperation =
      readFailedOperation(error) ||
      (typeof latestMeta.failedOperation === 'string' ? latestMeta.failedOperation : null) ||
      inferEcsFailedOperationFromPhase(failedPhase || String(latestMeta.phase || ''));
    const missingParameterName =
      parseMissingParameterName(technicalMessage) ||
      (Array.isArray((error as { missingFields?: string[] }).missingFields)
        ? (error as { missingFields: string[] }).missingFields[0]
        : null);
    const requestId =
      sdk.requestId ||
      extractRequestIdFromMessage(technicalMessage) ||
      null;
    const httpStatus =
      sdk.statusCode ??
      (/\bcode:\s*(\d{3})\b/i.exec(technicalMessage)?.[1]
        ? Number(/\bcode:\s*(\d{3})\b/i.exec(technicalMessage)![1])
        : null);
    await prisma.cloudResource.update({
      where: { id: cloudResourceId },
      data: {
        status: CloudResourceStatus.FAILED,
        metadata: {
          ...latestMeta,
          phase: 'FAILED',
          failedPhase: failedPhase || latestMeta.failedPhase || null,
          failedOperation,
          missingParameterName,
          lastErrorCode: code,
          providerErrorCode: sdk.code || (code === 'REQUEST_INVALID' ? 'MissingParameter' : null),
          lastErrorMessage: technicalMessage,
          lastErrorUserMessage: cloudEcsErrorUserMessage(
            code,
            failedOperation,
            missingParameterName,
          ),
          lastRequestId: requestId,
          httpStatus,
          failedAt: new Date().toISOString(),
          createFailureKind: classifyServerCreateFailureKind({
            errorCode: code,
            providerErrorCode: sdk.code,
            technicalMessage,
            httpStatus,
          }),
        } as Prisma.InputJsonObject,
      },
    });
    throw error;
  }
}

async function ensureServerInstance(
  prisma: PrismaClient,
  resource: {
    id: string;
    workspaceId: string;
    projectId?: string | null;
    publicIp: string | null;
    providerResourceId: string | null;
    region?: string | null;
    metadata?: unknown;
  },
) {
  if (!resource.publicIp || !resource.providerResourceId) return null;
  const meta = asMeta(resource.metadata);
  const passwordEncrypted = String(meta.passwordEncrypted || '');
  if (!passwordEncrypted) return null;

  const displayName = `LaunchOS ECS (${resource.providerResourceId})`;
  const patch = {
    host: resource.publicIp,
    port: 22,
    username: 'root',
    status: 'READY_FOR_INITIALIZATION',
    provider: 'ALIYUN',
    dockerStatus: 'UNKNOWN' as const,
    credentialEncrypted: passwordEncrypted,
    name: displayName,
  };

  const existingByMeta =
    typeof meta.serverInstanceId === 'string'
      ? await prisma.serverInstance.findUnique({ where: { id: meta.serverInstanceId } })
      : null;
  if (existingByMeta) {
    return prisma.serverInstance.update({
      where: { id: existingByMeta.id },
      data: patch,
    });
  }

  // Prefer reuse by providerResourceId (encoded in name) to avoid duplicate ServerInstance
  const existingByProvider = await prisma.serverInstance.findFirst({
    where: {
      workspaceId: resource.workspaceId,
      provider: 'ALIYUN',
      name: displayName,
    },
  });
  if (existingByProvider) {
    return prisma.serverInstance.update({
      where: { id: existingByProvider.id },
      data: patch,
    });
  }

  const existingByHost = await prisma.serverInstance.findFirst({
    where: {
      workspaceId: resource.workspaceId,
      host: resource.publicIp,
      provider: 'ALIYUN',
    },
  });
  if (existingByHost) {
    return prisma.serverInstance.update({
      where: { id: existingByHost.id },
      data: patch,
    });
  }

  return prisma.serverInstance.create({
    data: {
      workspaceId: resource.workspaceId,
      ...patch,
    },
  });
}

function asMeta(value: unknown): Meta {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Meta;
  }
  return {};
}

/**
 * Prevent BullMQ "completed" while CloudResource is still mid-create without an instance.
 */
async function failIfSilentlyIncomplete(
  prisma: PrismaClient,
  cloudResourceId: string,
): Promise<void> {
  const row = await prisma.cloudResource.findUnique({ where: { id: cloudResourceId } });
  if (!row) return;
  const meta = asMeta(row.metadata);
  if (
    !isServerProvisionSilentlyIncomplete({
      status: row.status,
      phase: typeof meta.phase === 'string' ? meta.phase : null,
      providerResourceId: row.providerResourceId,
    })
  ) {
    return;
  }
  const phase = typeof meta.phase === 'string' ? meta.phase : 'CREATING_INSTANCE';
  throw Object.assign(new Error('SERVER_PROVISION_INCOMPLETE'), {
    code: 'SERVER_PROVISION_INCOMPLETE',
    failedOperation: 'SERVER_PROVISION_INCOMPLETE',
    failedPhase: phase,
  });
}

async function withFailedOperation<T>(
  failedOperation: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const existing = readFailedOperation(error);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      failedOperation: existing || failedOperation,
    });
  }
}

function readFailedOperation(error: unknown): string | null {
  if (error && typeof error === 'object' && 'failedOperation' in error) {
    const value = (error as { failedOperation?: unknown }).failedOperation;
    return typeof value === 'string' && value.trim() ? value : null;
  }
  return null;
}

function extractRequestIdFromMessage(message: string | null | undefined): string | null {
  const m = String(message || '').match(/request id:\s*([0-9A-Fa-f-]+)/i);
  return m?.[1] || null;
}

function decryptProviderSecretsLocal(encrypted: string): {
  accessKey: string;
  secretKey: string;
} {
  const parsed = JSON.parse(decryptCredential(encrypted)) as {
    accessKey?: string;
    secretKey?: string;
  };
  if (!parsed.accessKey || !parsed.secretKey) {
    throw new Error('Aliyun credentials incomplete');
  }
  return { accessKey: parsed.accessKey, secretKey: parsed.secretKey };
}
