'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ControlCenter } from '@/components/control-center';
import { ProfileSubnav } from '@/components/control-center/profile-subnav';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader } from '@/components/ui/section';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { PublicUser } from '@/lib/types';

export default function ProfilePage() {
  const router = useRouter();
  const pathname = usePathname();
  const [profile, setProfile] = useState<PublicUser | null>(null);
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<PublicUser>('/account')
      .then((user) => {
        setProfile(user);
        setName(user.name);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : '加载失败'),
      );
  }, [router]);

  async function save() {
    setError('');
    setMessage('');
    try {
      const user = await api<PublicUser>('/account', {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      setProfile(user);
      setMessage('个人资料已保存');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    }
  }

  return (
    <ControlCenter>
      <PageHeader title="个人资料" description="管理个人信息与安全" />
      <ProfileSubnav pathname={pathname} />

      {!profile ? (
        error ? (
          <InlineAlert tone="error" title={error} />
        ) : (
          <Skeleton className="h-40" />
        )
      ) : (
        <Card className="p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-base font-medium text-white">
              {(profile.name || '用').trim().charAt(0)}
            </div>
            <div>
              <p className="font-medium">{profile.name}</p>
              <p className="text-sm text-[var(--los-secondary)]">{profile.email}</p>
            </div>
          </div>
          <label className="mt-5 block text-sm">
            <span className="text-[var(--los-secondary)]">姓名</span>
            <input
              className="mt-1 w-full max-w-md rounded-lg border border-[var(--los-border)] px-3 py-2"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm">
            <span className="text-[var(--los-secondary)]">邮箱</span>
            <input
              className="mt-1 w-full max-w-md rounded-lg border border-[var(--los-border)] bg-zinc-50 px-3 py-2"
              value={profile.email}
              disabled
            />
          </label>
          <button
            type="button"
            className="mt-4 rounded-lg bg-[var(--los-action)] px-4 py-2 text-sm text-white"
            onClick={() => void save()}
          >
            保存
          </button>
          {message ? <InlineAlert className="mt-3" tone="success" title={message} /> : null}
          {error ? <InlineAlert className="mt-3" tone="error" title={error} /> : null}
        </Card>
      )}
    </ControlCenter>
  );
}
