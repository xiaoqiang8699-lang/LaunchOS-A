'use client';

import { ControlCenter } from '@/components/control-center';
import { Card, PageHeader } from '@/components/ui/section';

export default function HelpPage() {
  return (
    <ControlCenter>
      <PageHeader title="帮助" description="快速了解 LaunchOS 控制台" />
      <Card className="space-y-3 p-5 text-sm text-[var(--los-secondary)]">
        <p>从左侧导航进入应用、团队、用量、套餐与账单。</p>
        <p>点击左下角头像可管理个人资料、安全设置，或退出登录。</p>
        <p>如需升级套餐，可前往「套餐」提交申请；账单页仅展示订单与支付记录。</p>
      </Card>
    </ControlCenter>
  );
}
