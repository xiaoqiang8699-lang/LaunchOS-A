/**
 * Step 30 — Chinese user-facing error copy (technical codes stay in details).
 */

export const LAUNCH_ERROR_USER_MESSAGES_ZH: Record<string, string> = {
  CONTAINER_REGISTRY_UNREACHABLE: '部署服务器暂时无法获取运行环境。',
  NOT_ENOUGH_BALANCE: '云账户余额不足，暂时无法创建服务器。',
  SECRET_MISSING: '还缺少必要的配置项，请先补全后再继续上线。',
  INVALID_USER_CODE: '应用代码有问题，需要先修复后再上线。',
  BUILD_FAIL: '应用构建失败，请根据提示修复代码后重试。',
  START_COMMAND_INVALID: '启动命令无效，请检查应用启动配置。',
  RUNTIME_CRASH: '应用启动后异常退出，请检查日志并修复代码。',
  IMAGE_ARCH_MISMATCH: '运行环境与镜像架构不匹配，需要调整配置后重试。',
  NETWORK_TIMEOUT: '网络暂时不稳定，可以稍后重试。',
  DEPENDENCY_MISSING: '还缺少必要的依赖（例如数据库），请先准备好。',
  SERVER_NOT_READY: '服务器还没有准备好，请稍后再试或创建服务器。',
  ALPHA_UNSUPPORTED_APPLICATION: '当前 Alpha 暂不支持这个应用结构。',
  LAUNCH_ALREADY_RUNNING: '应用正在上线，请稍候。',
  PLAN_STALE: '上线计划发生变化，请重新确认。',
  STEP30_REAL_EXECUTION_LOCKED: '真实一键上线将在下一阶段开放，当前仅支持生成上线计划。',
  STEP30_PHASE2_REAL_EXECUTION_LOCKED:
    '上线执行器已准备，真实执行暂未开放。当前仅支持计划、确认与只读检查。',
  BILLABLE_ACTION_CONFIRMATION_REQUIRED: '需要先确认将创建的云资源与费用。',
  CONFIRMATION_STALE: '费用确认已过期，请重新确认后再继续上线。',
  DUPLICATE_LAUNCH_LOCK: '已有进行中的上线任务，请等待完成后再试。',
  PROVIDER_TIMEOUT: '云服务响应超时，系统会先核对状态再继续，请稍后重试。',
  PROVIDER_RESULT_UNKNOWN: '云服务结果尚未明确，正在核对，不会重复创建。',
};

export function launchErrorUserMessage(errorCode: string | null | undefined, fallback?: string): string {
  if (!errorCode) return fallback ?? '上线过程遇到问题，请稍后重试。';
  return LAUNCH_ERROR_USER_MESSAGES_ZH[errorCode] ?? fallback ?? '上线过程遇到问题，请稍后重试。';
}

/** Product principle: diagnose only — never auto-modify user source. */
export const LAUNCH_USER_CODE_POLICY = {
  autoModifySource: false,
  produceFixPrompt: true,
  waitForUserRetry: true,
} as const;
