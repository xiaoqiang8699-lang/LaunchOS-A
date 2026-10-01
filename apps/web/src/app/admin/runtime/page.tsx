'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Runtime = {
  workerOnline: boolean;
  lastSeenAt: string | null;
  queues: Record<string, boolean>;
  capacity?: {
    queueDepth?: {
      deploymentQueue?: { waiting: number; active: number; failed: number };
    };
    limits?: Record<string, number>;
    warnings?: Array<{ serverId: string; code: string }>;
    servers?: Array<{
      id: string;
      name: string | null;
      host: string;
      status: string;
      admission: string;
      diskWarning: boolean;
      diskCritical: boolean;
      snapshot: {
        cpuCores: number | null;
        memoryTotalMb: number | null;
        memoryAvailableMb: number | null;
        diskFreeMb: number | null;
        diskUsedPercent: number | null;
        runningRuntimeCount: number;
        activeDeploymentCount: number;
        activeBuildCount: number;
        allocatedPortCount: number;
        probedAt: string;
      };
    }>;
  } | null;
  githubConnection?: {
    status: 'READY' | 'NOT_READY' | 'NOT_CONFIGURED';
    ready: boolean;
    callbackUrl: string | null;
    diagnosis: string | null;
    reason: string | null;
    requiresPublicHttps: boolean;
  };
};

export default function AdminRuntimePage() {
  const [data, setData] = useState<Runtime | null>(null);
  useEffect(() => {
    void api<Runtime>('/admin/runtime').then(setData).catch(() => setData(null));
  }, []);
  if (!data) return <p className="text-sm text-zinc-500">加载中…</p>;
  const github = data.githubConnection;
  const capacity = data.capacity;
  const queue = capacity?.queueDepth?.deploymentQueue;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-zinc-200 bg-white p-5 text-sm">
        <h2 className="font-medium text-zinc-900">系统运行</h2>
        <p className="mt-2">Worker：{data.workerOnline ? '在线' : '离线'}</p>
        <p className="mt-1">
          最近心跳：{data.lastSeenAt ? new Date(data.lastSeenAt).toLocaleString() : '无'}
        </p>
        <ul className="mt-3 space-y-1 text-zinc-600">
          {Object.entries(data.queues).map(([name, ready]) => (
            <li key={name}>
              {name}：{ready ? '就绪' : '未就绪'}
            </li>
          ))}
        </ul>
        <div className="mt-4 border-t border-zinc-100 pt-3">
          <p>
            GitHub 连接能力：
            {github?.ready ? '就绪' : github?.status === 'NOT_CONFIGURED' ? '未配置' : '未就绪'}
          </p>
          {github?.diagnosis ? <p className="mt-1 text-amber-700">{github.diagnosis}</p> : null}
        </div>
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-5 text-sm">
        <h2 className="font-medium text-zinc-900">Beta Capacity</h2>
        {queue ? (
          <p className="mt-2 text-zinc-600">
            上线队列：等待 {queue.waiting} · 执行中 {queue.active} · 失败 {queue.failed}
          </p>
        ) : null}
        {capacity?.limits ? (
          <p className="mt-1 text-zinc-500">
            限制：构建 {String(capacity.limits.maxConcurrentBuilds)} · 部署{' '}
            {String(capacity.limits.maxConcurrentDeploys)} · 运行实例{' '}
            {String(capacity.limits.maxRunningRuntimes)} · 内存{' '}
            {String(capacity.limits.runtimeMemoryLimitMb)}MB / CPU{' '}
            {String(capacity.limits.runtimeCpuLimit)}
          </p>
        ) : null}
        {capacity?.warnings?.length ? (
          <ul className="mt-2 space-y-1 text-amber-700">
            {capacity.warnings.map((w) => (
              <li key={`${w.serverId}-${w.code}`}>
                {w.code}（server {w.serverId.slice(0, 8)}…）
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-emerald-700">暂无容量告警</p>
        )}
        <div className="mt-3 space-y-3">
          {(capacity?.servers || []).map((server) => (
            <div key={server.id} className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2">
              <p className="font-medium text-zinc-800">
                {server.name || server.host} · {server.status} · 准入 {server.admission}
              </p>
              <p className="mt-1 text-zinc-600">
                CPU {server.snapshot.cpuCores ?? '—'} · 可用内存{' '}
                {server.snapshot.memoryAvailableMb ?? '—'} MB · 磁盘剩余{' '}
                {server.snapshot.diskFreeMb ?? '—'} MB（{server.snapshot.diskUsedPercent ?? '—'}%）
              </p>
              <p className="mt-1 text-zinc-600">
                运行中 {server.snapshot.runningRuntimeCount} · 构建中{' '}
                {server.snapshot.activeBuildCount} · 部署中{' '}
                {server.snapshot.activeDeploymentCount} · 端口{' '}
                {server.snapshot.allocatedPortCount}
              </p>
              {server.diskWarning || server.diskCritical ? (
                <p className="mt-1 text-amber-700">
                  {server.diskCritical ? 'DISK_CRITICAL' : 'DISK_WARNING'}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
