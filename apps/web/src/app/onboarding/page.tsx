'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OnboardingLayout } from '@/components/onboarding-layout';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';

type Stage = 'CONNECT' | 'ANALYZE' | 'PLAN' | 'LAUNCH' | 'SUCCESS';

type OnboardingState = {
  onboardingStatus: string;
  shouldEnterOnboarding: boolean;
  stage: Stage;
  projectId: string | null;
  findings: string[];
  uncertainties: string[];
  launchStatus: string | null;
  publicUrl: string | null;
};

export default function OnboardingHomePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<OnboardingState>('/onboarding')
      .then((state) => {
        if (!state.shouldEnterOnboarding) {
          router.replace('/dashboard');
          return;
        }
        if (state.stage !== 'CONNECT') {
          // Resume later stages on the guided flow page.
          router.replace('/onboarding/flow');
          return;
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : '加载失败');
        setLoading(false);
      });
  }, [router]);

  function start(): void {
    router.push('/projects/new?from=onboarding');
  }

  return (
    <OnboardingLayout>
      <div>
        <p className="text-sm text-zinc-500">欢迎使用 LaunchOS</p>
        <h1 className="mt-2 text-3xl font-semibold text-zinc-900">开始第一次上线</h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          连接你的代码，LaunchOS 会自动识别应用并准备上线方案。
        </p>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <section className="rounded-2xl border border-zinc-200 bg-white p-6">
        {loading ? (
          <p className="text-sm text-zinc-500">准备中…</p>
        ) : (
          <button
            className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white"
            type="button"
            onClick={start}
          >
            开始第一次上线
          </button>
        )}
      </section>
    </OnboardingLayout>
  );
}
