/**
 * Managed container recovery. Deployment history stays independent of runtime state.
 *
 * unless-stopped on new containers:
 * - process crash → Podman/conmon restarts the container
 * - host reboot → launchos-podman-restart.service starts containers with this policy
 * - explicit `podman stop` → stays stopped until an operator starts it
 *
 * Podman 4.9.3 `podman update` cannot change restart policy (cgroup flags only).
 * Existing containers are not recreated. Their reboot and crash recovery is a
 * generated systemd unit (`podman generate systemd --name --restart-policy=on-failure`,
 * without `--new`): Restart=on-failure, ExecStart=`podman start`. `systemctl stop` stays stopped.
 */

export const MANAGED_CONTAINER_RESTART_POLICY = 'unless-stopped' as const;

export const RUNTIME_RECOVERY_POLICY = {
  restartPolicy: MANAGED_CONTAINER_RESTART_POLICY,
  bootRecovery: 'systemd-oneshot-podman-start-unless-stopped',
  existingContainerRecovery: 'podman-generate-systemd-on-failure-no-new',
  healthReconcile: true,
  maxRestartObservation: 3,
  failureClassification: {
    exitZero: 'STOPPED',
    exitNonZero: 'FAILED',
    missing: 'FAILED',
    healthFail: 'UNHEALTHY',
    healthOk: 'HEALTHY',
  },
} as const;

export type ServiceRuntimeStatus = 'RUNNING' | 'STOPPED' | 'FAILED';
export type ServiceHealthFact = 'HEALTHY' | 'UNHEALTHY' | 'UNKNOWN';

export type ContainerRuntimeObservation =
  | { exists: false }
  | { exists: true; running: true; exitCode?: number | null }
  | { exists: true; running: false; exitCode: number | null };

export function reconcileServiceInstanceRuntimeState(input: {
  observation: ContainerRuntimeObservation;
  healthProbe?: 'success' | 'fail' | 'skipped';
}): {
  status: ServiceRuntimeStatus;
  healthStatus: ServiceHealthFact;
  healthMessage: string;
} {
  if (!input.observation.exists) {
    return {
      status: 'FAILED',
      healthStatus: 'UNHEALTHY',
      healthMessage: '运行实例不存在',
    };
  }

  if (!input.observation.running) {
    if (input.observation.exitCode === 0) {
      return {
        status: 'STOPPED',
        healthStatus: 'UNHEALTHY',
        healthMessage: '应用已停止',
      };
    }
    return {
      status: 'FAILED',
      healthStatus: 'UNHEALTHY',
      healthMessage: '应用异常退出',
    };
  }

  if (input.healthProbe === 'fail') {
    return {
      status: 'RUNNING',
      healthStatus: 'UNHEALTHY',
      healthMessage: '应用暂时没有响应',
    };
  }
  if (input.healthProbe === 'success') {
    return {
      status: 'RUNNING',
      healthStatus: 'HEALTHY',
      healthMessage: '运行正常',
    };
  }
  return {
    status: 'RUNNING',
    healthStatus: 'UNKNOWN',
    healthMessage: '正在检查应用状态',
  };
}
