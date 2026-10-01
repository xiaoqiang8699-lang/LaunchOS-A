'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api } from '@/lib/api';
import { setAccessToken } from '@/lib/auth';
import type { LoginResponse } from '@/lib/types';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setAccessToken(result.accessToken);
      window.sessionStorage.removeItem('launchos-onboarding-console');
      router.push(result.user.hasCompletedOnboarding ? '/dashboard' : '/onboarding');
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-50 px-6">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold text-zinc-900">登录 LaunchOS</h1>
        <p className="mt-2 text-sm text-zinc-500">使用邮箱和密码进入工作空间。</p>

        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <label className="block text-sm font-medium text-zinc-700">
            邮箱
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label className="block text-sm font-medium text-zinc-700">
            密码
            <input
              className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 text-zinc-900 outline-none focus:border-zinc-400"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <button
            className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
            type="submit"
            disabled={pending}
          >
            {pending ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-500">
          还没有账号？{' '}
          <Link className="font-medium text-zinc-900 underline" href="/register">
            注册
          </Link>
        </p>
      </div>
    </main>
  );
}
