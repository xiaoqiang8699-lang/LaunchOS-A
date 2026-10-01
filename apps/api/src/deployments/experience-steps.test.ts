import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CloudResourceStatus,
  DeploymentStatus,
  DeploymentStepStatus,
  HealthStatus,
  ServiceStatus,
} from '@launchos/database';
import { buildExperienceProgress, shortFailureCause } from './experience-steps';

describe('buildExperienceProgress', () => {
  it('maps real engine steps without duplicate upload and keeps order on health failure', () => {
    const { steps, progress } = buildExperienceProgress({
      status: DeploymentStatus.FAILED,
      serverInstanceId: 'server_1',
      steps: [
        { stepKey: 'VALIDATE_SOURCE', status: DeploymentStepStatus.SUCCESS, attempt: 3 },
        { stepKey: 'BUILD_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 3 },
        { stepKey: 'STORE_ARTIFACT', status: DeploymentStepStatus.SUCCESS, attempt: 3 },
        { stepKey: 'DEPLOY_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 3 },
        { stepKey: 'REMOTE_DEPLOY', status: DeploymentStepStatus.SKIPPED, attempt: 3 },
        {
          stepKey: 'HEALTH_CHECK',
          status: DeploymentStepStatus.FAILED,
          attempt: 3,
          errorMessage: 'Health check 失败：timeout',
        },
      ],
      remoteDeployments: [],
      cloudResources: [],
      service: { status: ServiceStatus.RUNNING, healthStatus: HealthStatus.UNHEALTHY },
      deployableUnit: { name: 'web', type: 'WEB', rootPath: 'apps/web' },
    });

    assert.deepEqual(
      steps.map((step) => step.key),
      ['ANALYZE', 'PREPARE_ENV', 'BUILD_UPLOAD', 'START_SERVICE', 'GO_LIVE'],
    );
    assert.deepEqual(
      steps.map((step) => step.name),
      ['分析应用', '准备环境', '构建并上传', '启动服务', '完成上线'],
    );
    assert.equal(steps.filter((step) => step.name.includes('上传')).length, 1);
    assert.equal(steps[0]?.status, 'SUCCESS');
    assert.equal(steps[1]?.status, 'SUCCESS');
    assert.equal(steps[2]?.status, 'SUCCESS');
    assert.equal(steps[3]?.status, 'SUCCESS');
    assert.equal(steps[4]?.status, 'FAILED');
    assert.equal(steps[4]?.failureReason, '健康检查失败');
    assert.equal(progress.unitLabel, '官网');
    assert.equal(shortFailureCause(steps, 'Health check 失败'), '健康检查失败');
  });

  it('blocks later success when earlier step failed', () => {
    const { steps } = buildExperienceProgress({
      status: DeploymentStatus.FAILED,
      serverInstanceId: 'server_1',
      steps: [
        { stepKey: 'VALIDATE_SOURCE', status: DeploymentStepStatus.FAILED, attempt: 1 },
        { stepKey: 'BUILD_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'STORE_ARTIFACT', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'DEPLOY_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'REMOTE_DEPLOY', status: DeploymentStepStatus.SKIPPED, attempt: 1 },
        { stepKey: 'HEALTH_CHECK', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
      ],
      remoteDeployments: [],
      cloudResources: [],
      service: { status: ServiceStatus.RUNNING, healthStatus: HealthStatus.HEALTHY },
      deployableUnit: { name: 'web', type: 'WEB', rootPath: 'apps/web' },
    });

    assert.equal(steps[0]?.status, 'FAILED');
    assert.equal(steps[1]?.status, 'WAITING');
    assert.equal(steps[2]?.status, 'WAITING');
    assert.equal(steps[3]?.status, 'WAITING');
    assert.equal(steps[4]?.status, 'WAITING');
  });

  it('requires healthy running service for go-live success', () => {
    const { steps } = buildExperienceProgress({
      status: DeploymentStatus.SUCCESS,
      serverInstanceId: 'server_1',
      steps: [
        { stepKey: 'VALIDATE_SOURCE', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'BUILD_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'STORE_ARTIFACT', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'DEPLOY_APPLICATION', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
        { stepKey: 'REMOTE_DEPLOY', status: DeploymentStepStatus.SKIPPED, attempt: 1 },
        { stepKey: 'HEALTH_CHECK', status: DeploymentStepStatus.SUCCESS, attempt: 1 },
      ],
      remoteDeployments: [],
      cloudResources: [{ status: CloudResourceStatus.RUNNING }],
      service: { status: ServiceStatus.RUNNING, healthStatus: HealthStatus.UNHEALTHY },
      deployableUnit: { name: 'api', type: 'API', rootPath: 'apps/api' },
    });

    assert.equal(steps[4]?.status, 'RUNNING');
  });
});
