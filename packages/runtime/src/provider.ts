import { LocalDockerRuntime, RuntimeError } from './runtime.service';
import { RemoteDockerRuntime } from './remote-docker-runtime';
import type { RemoteRuntimeConnection, RuntimeProvider, RuntimeProviderKind } from './types';

export function createRuntimeProvider(
  kind: RuntimeProviderKind,
  connection?: RemoteRuntimeConnection,
): RuntimeProvider {
  if (kind === 'remote') {
    if (!connection?.host || !connection.username || !connection.password) {
      throw new RuntimeError('RemoteDockerRuntime 需要 SSH 主机、用户名和密码');
    }
    return new RemoteDockerRuntime(connection);
  }
  return new LocalDockerRuntime();
}
