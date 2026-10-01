'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { ProfileSubnav } from '@/components/control-center/profile-subnav';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

type Security = {
  account: { email: string; name: string; createdAt: string } | null;
  lastLoginAt: string | null;
  sessions: Array<{
    id: string;
    userAgent: string | null;
    createdAt: string;
    current: boolean;
    revokedAt: string | null;
  }>;
};

export default function ProfileSecurityPage() {
  const router = useRouter();
  const pathname = usePathname();
  const [security, setSecurity] = useState<Security | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function load() {
    const payload = await api<Security>('/account/security');
    setSecurity(payload);
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void load().catch((err: unknown) =>
      setError(err instanceof ApiError ? err.message : '加载失败'),
    );
  }, [router]);

  async function changePassword() {
    setError('');
    setMessage('');
    try {
      await api('/account/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, nextPassword }),
      });
      setCurrentPassword('');
      setNextPassword('');
      setMessage('密码已更新');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '修改密码失败');
    }
  }

  async function revokeOthers() {
    setError('');
    setMessage('');
    try {
      await api('/account/sessions/revoke-others', { method: 'POST' });
      setMessage('其他会话已退出');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  return (
    <ControlCenter>
      <PageHeader title="个人资料" description="管理个人信息与安全" />
      <ProfileSubnav pathname={pathname} />

      {!security ? (
        error ? (
          <InlineAlert tone="error" title={error} />
        ) : (
          <Skeleton className="h-40" />
        )
      ) : (
        <div className="space-y-5">
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold">修改密码</h2>
            <div className="mt-3 grid max-w-md gap-3">
              <input
                type="password"
                className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                placeholder="当前密码"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
              <input
                type="password"
                className="rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                placeholder="新密码"
                value={nextPassword}
                onChange={(e) => setNextPassword(e.target.value)}
              />
              <button
                type="button"
                className="w-fit rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm text-white"
                onClick={() => void changePassword()}
              >
                更新密码
              </button>
            </div>
          </Card>

          <Card className="p-5 text-sm">
            <h2 className="text-[15px] font-semibold">最近登录</h2>
            <p className="mt-2 text-[var(--los-secondary)]">
              {security.lastLoginAt
                ? new Date(security.lastLoginAt).toLocaleString()
                : '暂无记录'}
            </p>
          </Card>

          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">会话</h2>
              <button
                type="button"
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                onClick={() => void revokeOthers()}
              >
                退出其他会话
              </button>
            </div>
            <ul className="mt-3 divide-y divide-[var(--los-border)] text-sm">
              {security.sessions.map((session) => (
                <li key={session.id} className="py-2">
                  <p className="font-medium">
                    {session.current ? '当前会话' : '其他会话'}
                    {session.revokedAt ? ' · 已退出' : ''}
                  </p>
                  <p className="text-[var(--los-secondary)]">
                    {session.userAgent || '未知设备'} ·{' '}
                    {new Date(session.createdAt).toLocaleString()}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          {message ? <InlineAlert tone="success" title={message} /> : null}
          {error ? <InlineAlert tone="error" title={error} /> : null}
        </div>
      )}
    </ControlCenter>
  );
}
