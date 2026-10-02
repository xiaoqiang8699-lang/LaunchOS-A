'use client';

import { useState } from 'react';
import { InlineAlert } from '@/components/ui/feedback';
import { PrimaryButton, SecondaryButton } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { ServerConnectionTest, ServerInstance } from '@/lib/types';

type ConnectServerDialogProps = {
  open: boolean;
  onClose: () => void;
  onConnected: (server: ServerInstance, probe: ServerConnectionTest | null) => void;
};

export function ConnectServerDialog({ open, onClose, onConnected }: ConnectServerDialogProps) {
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

  if (!open) return null;

  async function connect(): Promise<void> {
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
      onConnected(created, result);
      if (result.diagnosis?.canDeploy) {
        onClose();
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

  function handleClose() {
    if (pending || testing) return;
    setError('');
    setProbe(null);
    setForm({ name: '', host: '', port: '22', username: 'root', password: '' });
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-server-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-[var(--los-border)] bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 id="connect-server-title" className="text-base font-semibold text-[var(--los-text)]">
              连接服务器
            </h3>
            <p className="mt-1 text-sm text-[var(--los-secondary)]">
              把已有云服务器接入 LaunchOS（不会自动购买服务器）
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-sm text-[var(--los-secondary)] hover:bg-zinc-100"
            onClick={handleClose}
            disabled={pending || testing}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4">
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

          <div className="flex justify-end gap-2 pt-1">
            <SecondaryButton type="button" onClick={handleClose} disabled={pending || testing}>
              取消
            </SecondaryButton>
            <PrimaryButton
              type="button"
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
            </PrimaryButton>
          </div>
        </div>
      </div>
    </div>
  );
}
