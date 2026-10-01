import { PublicFooter, PublicHeader } from '@/components/public-site';

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      <PublicHeader />
      <main className="mx-auto w-full max-w-3xl space-y-4 px-4 py-12 text-sm leading-7 text-zinc-700 sm:px-6">
        <h1 className="text-3xl font-semibold text-zinc-900">隐私政策</h1>
        <p>这是基础说明页。LaunchOS 的正式隐私政策尚未发布。</p>
        <p>正式版本会说明收集哪些信息、用来做什么，以及如何联系我们。在正式文本发布前，本页不构成完整的隐私承诺。</p>
      </main>
      <PublicFooter />
    </div>
  );
}
