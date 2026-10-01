import { api } from '@/lib/api';
import type { DeploymentDetail, ProjectDetail, ProjectEnvironment } from '@/lib/types';

export function goLivePath(projectId: string, deployableUnitId?: string | null): string {
  const base = `/projects/${projectId}/go-live`;
  if (!deployableUnitId) {
    return base;
  }
  return `${base}?unitId=${encodeURIComponent(deployableUnitId)}`;
}

export async function startProjectDeployment(
  projectId: string,
  options?: {
    environmentId?: string;
    hostingMode?: 'launchos' | 'my-server';
    serverInstanceId?: string;
    deployableUnitId?: string | null;
  },
): Promise<string> {
  let envId = options?.environmentId?.trim() || '';
  if (!envId) {
    const project = await api<ProjectDetail>(`/projects/${projectId}`);
    envId = project.environments[0]?.id || '';
    if (!envId) {
      const environment = await api<ProjectEnvironment>(`/projects/${projectId}/environments`, {
        method: 'POST',
        body: JSON.stringify({ type: 'development' }),
      });
      envId = environment.id;
    }
  }

  const hostingMode = options?.hostingMode ?? (options?.serverInstanceId ? 'my-server' : 'launchos');
  const created = await api<DeploymentDetail>(`/projects/${projectId}/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      environmentId: envId,
      hostingMode,
      serverInstanceId: hostingMode === 'my-server' ? options?.serverInstanceId : undefined,
      deployableUnitId: options?.deployableUnitId || undefined,
    }),
  });
  return created.id;
}
