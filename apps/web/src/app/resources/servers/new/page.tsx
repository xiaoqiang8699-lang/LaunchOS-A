'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { InlineAlert } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { ServerConnectionTest, ServerInstance } from '@/lib/types';

export default function ConnectServerPage() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [probe, setProbe] = useState<ServerConnectionTest | null>(null);
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: '22',
    username: 'root',
    password: '',
  });

  async function connect(): Promise<void> {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    setPending(true);
    setError('');
    setProbe(null);
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
      setTesting(true);
      const result = await api<ServerConnectionTest>(`/servers/${created.id}/test-connection`, {
        method: 'POST',
      });
      setProbe(result);
      if (result.diagnosis?.canDeploy) {
        router.push('/resources');
        return;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '连接失败');
    } finally {
      setPending(false);
      setTesting(false);
    }
  }

  const readyLabel = probe?.diagnosis?.canDeploy
    ? '准备完成'
    : probe?.connected
      ? '需要初始化'
      : probe
        ? '连接失败'
        : null;

  return (
    <ControlCenter>
      <PageHeader
        title="连接服务器"
        description="把已有云服务器接入 LaunchOS（不会自动购买服务器）"
        action={
          <Link className="text-sm underline" href="/resources">
            返回运行资源
          </Link>
        }
      />

      <Card className="space-y-4 p-5">
        <label className="block text-sm">
          服务器名称
          <input
            className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="生产机"
          />
        </label>
        <label className="block text-sm">
          公网 IP / hostname
          <span className="mt-0.5 block text-xs text-[var(--los-muted)]">{PRODUCT_COPY.serverHostHint}</span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2"
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            placeholder="8.8.8.8 或 server.example.com"
          />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            SSH 端口
            <input
              className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2"
              value={form.port}
              onChange={(e) => setForm({ ...form, port: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            SSH 用户
            <input
              className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
        </div>
        <label className="block text-sm">
          认证方式：密码
          <span className="mt-0.5 block text-xs text-[var(--los-muted)]">
            凭据会加密保存，不会明文返回
          </span>
          <input
            className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>

        {error ? <InlineAlert tone="error" title={error} /> : null}
        {readyLabel ? (
          <InlineAlert
            tone={probe?.diagnosis?.canDeploy ? 'success' : 'warning'}
            title={readyLabel}
            description={probe?.diagnosis?.summary}
          />
        ) : null}

        <button
          type="button"
          className="rounded-lg bg-[var(--los-action)] px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
          disabled={
            pending ||
            testing ||
            !form.name.trim() ||
            !form.host.trim() ||
            !form.password
          }
          onClick={() => void connect()}
        >
          {pending || testing ? '连接并检测中…' : '连接并检测'}
        </button>
      </Card>
    </ControlCenter>
  );
}
