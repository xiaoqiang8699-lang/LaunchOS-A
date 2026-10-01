'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import { SERVER_INSTANCE_STATUS_LABELS, SERVER_READY_LABELS } from '@/lib/project-labels';
import { startProjectDeployment } from '@/lib/start-deploy';
import type { HostingMode, ProjectDetail, ServerConnectionTest, ServerInstance } from '@/lib/types';

export default function GoLivePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [servers, setServers] = useState<ServerInstance[]>([]);
  const [hostingMode, setHostingMode] = useState<HostingMode>('launchos');
  const [serverId, setServerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    password: '',
  });

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;
    Promise.all([api<ProjectDetail>(`/projects/${params.id}`), api<ServerInstance[]>('/servers')])
      .then(([detail, list]) => {
        if (cancelled) {
          return;
        }
        setProject(detail);
        setServers(list);
        setServerId((current) => current || list[0]?.id || '');
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        clearAccessToken();
        setError(err instanceof Error ? err.message : '加载失败');
        router.replace('/login');
      });

    return () => {
      cancelled = true;
    };
  }, [params.id, router]);

  const selected = servers.find((item) => item.id === serverId) ?? null;
  const canConfirm =
    hostingMode === 'launchos' || (hostingMode === 'my-server' && Boolean(selected));

  async function refreshServers(): Promise<ServerInstance[]> {
    const list = await api<ServerInstance[]>('/servers');
    setServers(list);
    return list;
  }

  async function addServer(): Promise<void> {
    setPending(true);
    setError(null);
    setCheckMessage(null);
    try {
      const created = await api<ServerInstance>('/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          host: form.host.trim(),
          port: Number(form.port) || 22,
          username: form.username.trim(),
          password: form.password,
        }),
      });
      setForm((current) => ({ ...current, password: '' }));
      const list = await refreshServers();
      const next = list.find((item) => item.id === created.id) ?? created;
      setServerId(next.id);
      setHostingMode('my-server');
      setShowAdd(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setPending(false);
    }
  }

  async function checkServer(id: string): Promise<void> {
    setCheckingId(id);
    setError(null);
    try {
      const result = await api<ServerConnectionTest>(`/servers/${id}/test-connection`, {
        method: 'POST',
      });
      await refreshServers();
      if (!result.connected) {
        setCheckMessage(result.diagnosis?.summary ?? '服务器无法连接');
        setError(result.diagnosis?.checks?.join('\n') ?? '请检查 IP、端口、账号、密码和防火墙');
        return;
      }
      setCheckMessage(
        result.diagnosis?.summary ??
          (result.dockerStatus === 'READY' ? PRODUCT_COPY.serverUsable : PRODUCT_COPY.serverUnusable),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : PRODUCT_COPY.serverUnusable);
      await refreshServers().catch(() => undefined);
    } finally {
      setCheckingId(null);
    }
  }

  async function confirm(): Promise<void> {
    if (!canConfirm) {
      setError(PRODUCT_COPY.noServersYet);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const unitId =
        typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('unitId')
          : null;
      const deploymentId = await startProjectDeployment(params.id, {
        hostingMode,
        serverInstanceId: hostingMode === 'my-server' ? serverId : undefined,
        deployableUnitId: unitId,
      });
      router.push(`/deployments/${deploymentId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setError('上线服务暂时不可用，请稍后重试。');
      } else if (err instanceof ApiError && /运行配置/.test(err.message)) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : '开始上线失败');
      }
      setPending(false);
    }
  }

  if (!project) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${project.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">{PRODUCT_COPY.chooseHosting}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {project.name} · {PRODUCT_COPY.chooseHostingHint}
          </p>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        ) : null}

        <ul className="grid gap-3 sm:grid-cols-2">
          <HostingCard
            selected={hostingMode === 'launchos'}
            title={PRODUCT_COPY.hostingLaunchos}
            badge="推荐"
            description="不用准备服务器，LaunchOS 会自动完成运行环境的准备。"
            onClick={() => {
              setHostingMode('launchos');
              setShowAdd(false);
            }}
          />
          <HostingCard
            selected={hostingMode === 'my-server'}
            title="使用自己的服务器"
            description="已有服务器的用户可以选择自己的机器。"
            onClick={() => setHostingMode('my-server')}
          />
        </ul>

        {hostingMode === 'my-server' ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6">
            <h2 className="text-sm font-medium text-zinc-900">使用自己的服务器</h2>
            <p className="mt-1 text-sm text-zinc-500">
              适合已经拥有并管理服务器的用户。如果你没有服务器，建议返回并使用 LaunchOS 自动托管。
            </p>
            <button
              className="mt-3 text-sm text-zinc-500 underline"
              type="button"
              onClick={() => {
                setHostingMode('launchos');
                setShowAdd(false);
              }}
            >
              返回使用 LaunchOS 自动托管
            </button>

            {servers.length > 0 ? (
              <div className="mt-5 flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-zinc-900">{PRODUCT_COPY.selectServer}</h3>
                <button
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
                  type="button"
                  onClick={() => setShowAdd((current) => !current)}
                >
                  添加自己的服务器
                </button>
              </div>
            ) : null}

            {servers.length === 0 ? (
              <div className="mt-5">
                <p className="text-sm font-medium text-zinc-900">还没有自己的服务器</p>
                <p className="mt-1 text-sm text-zinc-500">
                  如果你已经购买并管理服务器，可以在这里连接。
                </p>
                <button
                  className="mt-3 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700"
                  type="button"
                  onClick={() => setShowAdd(true)}
                >
                  添加自己的服务器
                </button>
              </div>
            ) : (
              <ul className="mt-4 space-y-2">
                {servers.map((server) => {
                  const active = server.id === serverId;
                  return (
                    <li key={server.id}>
                      <button
                        className={`w-full rounded-xl border px-4 py-3 text-left ${
                          active ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-100 hover:border-zinc-300'
                        }`}
                        type="button"
                        onClick={() => {
                          setServerId(server.id);
                          setCheckMessage(null);
                        }}
                      >
                        <p className="font-medium text-zinc-900">{server.name}</p>
                        <p className="mt-1 text-sm text-zinc-500">{server.host}</p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {SERVER_INSTANCE_STATUS_LABELS[server.status] ?? server.status} ·{' '}
                          {SERVER_READY_LABELS[server.dockerStatus] ?? PRODUCT_COPY.serverUnknown}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {selected ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-50"
                  type="button"
                  disabled={checkingId === selected.id}
                  onClick={() => void checkServer(selected.id)}
                >
                  {checkingId === selected.id ? PRODUCT_COPY.checkingServer : PRODUCT_COPY.checkServer}
                </button>
                {checkMessage ? <p className="text-sm text-zinc-600">{checkMessage}</p> : null}
              </div>
            ) : null}

            {showAdd ? (
              <div className="mt-6 border-t border-zinc-100 pt-5">
                <h3 className="text-sm font-medium text-zinc-900">连接自己的服务器</h3>
                <p className="mt-1 text-sm text-zinc-500">
                  适合已经拥有并管理服务器的用户。如果你没有服务器，建议返回并使用 LaunchOS 自动托管。
                </p>
                <button
                  className="mt-2 text-sm text-zinc-500 underline"
                  type="button"
                  onClick={() => {
                    setHostingMode('launchos');
                    setShowAdd(false);
                  }}
                >
                  使用 LaunchOS 自动托管
                </button>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm text-zinc-600">
                    名称
                    <span className="mt-0.5 block text-xs text-zinc-500">{PRODUCT_COPY.serverNameHint}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      placeholder="生产机"
                    />
                  </label>
                  <label className="text-sm text-zinc-600">
                    服务器地址
                    <span className="mt-0.5 block text-xs text-zinc-500">{PRODUCT_COPY.serverHostHint}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                      value={form.host}
                      onChange={(event) => setForm({ ...form, host: event.target.value })}
                      placeholder="8.138.113.134"
                    />
                  </label>
                  <label className="text-sm text-zinc-600">
                    SSH端口
                    <span className="mt-0.5 block text-xs text-zinc-500">{PRODUCT_COPY.serverPortHint}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                      value={form.port}
                      onChange={(event) => setForm({ ...form, port: event.target.value })}
                    />
                  </label>
                  <label className="text-sm text-zinc-600">
                    用户名
                    <span className="mt-0.5 block text-xs text-zinc-500">{PRODUCT_COPY.serverUsernameHint}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                      value={form.username}
                      onChange={(event) => setForm({ ...form, username: event.target.value })}
                    />
                  </label>
                  <label className="text-sm text-zinc-600 sm:col-span-2">
                    密码
                    <span className="mt-0.5 block text-xs text-zinc-500">{PRODUCT_COPY.serverPasswordHint}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-900"
                      type="password"
                      value={form.password}
                      onChange={(event) => setForm({ ...form, password: event.target.value })}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <button
                  className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                  type="button"
                  disabled={pending || !form.name.trim() || !form.host.trim() || !form.password}
                  onClick={() => void addServer()}
                >
                  {pending ? '添加中…' : PRODUCT_COPY.addServer}
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          <section className="rounded-2xl border border-emerald-200 bg-white p-6">
            <p className="text-sm font-medium text-zinc-900">LaunchOS 自动托管 · 推荐</p>
            <p className="mt-1 text-sm text-zinc-600">
              不用准备服务器，LaunchOS 会自动完成运行环境的准备。确认后即可开始上线。
            </p>
          </section>
        )}

        <button
          className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          type="button"
          disabled={pending || !canConfirm || project.sources.length === 0}
          onClick={() => void confirm()}
        >
          {pending ? PRODUCT_COPY.goingLive : PRODUCT_COPY.confirmGoLive}
        </button>
        {project.sources.length === 0 ? (
          <p className="text-sm text-zinc-500">请先连接代码后再上线。</p>
        ) : null}
      </div>
    </main>
  );
}

function HostingCard(props: {
  selected: boolean;
  title: string;
  description: string;
  badge?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        className={`h-full w-full rounded-2xl border px-5 py-4 text-left ${
          props.selected ? 'border-zinc-900 bg-white' : 'border-zinc-200 bg-white hover:border-zinc-300'
        }`}
        type="button"
        onClick={props.onClick}
      >
        <p className="font-medium text-zinc-900">
          {props.title}
          {props.badge ? (
            <span className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
              {props.badge}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-sm text-zinc-500">{props.description}</p>
        {props.selected ? <p className="mt-2 text-xs text-zinc-500">已选中</p> : null}
      </button>
    </li>
  );
}
