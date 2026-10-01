/**
 * Step 32 — user-facing deployment / launch failure presentation.
 * Keep raw stacks, IPs, secrets, and exit dumps out of ordinary user UI.
 */

export const DEPLOYMENT_FAILURE_CATEGORIES = [
  'USER_CODE',
  'USER_CONFIG',
  'PLATFORM',
  'INFRASTRUCTURE',
  'TRANSIENT',
] as const;

export type DeploymentFailureCategory = (typeof DEPLOYMENT_FAILURE_CATEGORIES)[number];

export const DEPLOYMENT_FAILURE_PRODUCT_STAGES = [
  'BUILD',
  'DEPLOY',
  'RUNTIME_START',
  'HEALTHCHECK',
  'PUBLIC_ENTRY',
  'VERIFY',
  'UNKNOWN',
] as const;

export type DeploymentFailureProductStage = (typeof DEPLOYMENT_FAILURE_PRODUCT_STAGES)[number];

export type DeploymentFailurePresentation = {
  category: DeploymentFailureCategory;
  title: string;
  stageLabel: string;
  productStage: DeploymentFailureProductStage;
  userMessage: string;
  suggestedAction: string;
  retryable: boolean;
  fixPromptAvailable: boolean;
  /** Stable technical code for admins / Alpha P1 — not shown as primary user copy. */
  techCode: string;
  /** Optional path hint for config UI (never includes secrets). */
  configPath: string | null;
  /** Copy-paste Fix Prompt for Codex/Cursor/Claude — never includes secrets/tokens. */
  fixPrompt: string | null;
};

const STAGE_LABEL_ZH: Record<DeploymentFailureProductStage, string> = {
  BUILD: '构建应用',
  DEPLOY: '部署应用',
  RUNTIME_START: '启动应用',
  HEALTHCHECK: '健康检查',
  PUBLIC_ENTRY: '配置访问入口',
  VERIFY: '上线检查',
  UNKNOWN: '上线过程',
};

const CODE_MAP: Record<
  string,
  Omit<DeploymentFailurePresentation, 'fixPrompt' | 'configPath' | 'techCode'> & {
    techCode: string;
  }
> = {
  RUNTIME_CONFIG_MISSING: {
    category: 'USER_CONFIG',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '上线前还缺少必要的运行配置。',
    suggestedAction: '请补全应用运行配置后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'RUNTIME_CONFIG_MISSING',
  },
  RUNTIME_CONFIG_INJECTION_MISMATCH: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '运行配置已保存，但未能正确注入到运行环境。',
    suggestedAction: '这是平台问题，请稍后重试。无需修改代码或重新填写配置。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'RUNTIME_CONFIG_INJECTION_MISMATCH',
  },
  CAPACITY_UNAVAILABLE: {
    category: 'PLATFORM',
    title: '暂时无法上线',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '当前上线资源繁忙，请稍后重试。',
    suggestedAction: '请稍后再试，无需修改代码。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'CAPACITY_UNAVAILABLE',
  },
  CAPACITY_DISK_CRITICAL: {
    category: 'PLATFORM',
    title: '暂时无法上线',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '当前上线资源繁忙，请稍后重试。',
    suggestedAction: '请稍后再试，无需修改代码。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'CAPACITY_DISK_CRITICAL',
  },
  CAPACITY_BUILD_SLOTS_FULL: {
    category: 'PLATFORM',
    title: '等待构建资源',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '正在等待构建资源，请稍后重试。',
    suggestedAction: '系统正在处理其他上线任务，请稍后再试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'CAPACITY_BUILD_SLOTS_FULL',
  },
  SECRET_MISSING: {
    category: 'USER_CONFIG',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '还缺少必要的密钥或敏感配置。',
    suggestedAction: '请在运行配置中补全缺失项后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'SECRET_MISSING',
  },
  DEPENDENCY_NOT_READY: {
    category: 'USER_CONFIG',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '应用依赖尚未就绪。',
    suggestedAction: '请先完成数据库或 Redis 等依赖配置后再重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'DEPENDENCY_NOT_READY',
  },
  BUILD_FAILED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '应用构建失败。',
    suggestedAction: '请根据构建错误修复项目代码或依赖后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'BUILD_FAILED',
  },
  BUILD_FAIL: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '应用构建失败。',
    suggestedAction: '请根据构建错误修复项目代码或依赖后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'BUILD_FAIL',
  },
  INVALID_USER_CODE: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '应用代码存在问题，需要先修复。',
    suggestedAction: '请修复代码后重新上线。LaunchOS 不会自动修改你的代码。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'INVALID_USER_CODE',
  },
  SOURCE_FETCH_FAILED: {
    category: 'USER_CONFIG',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '无法获取代码仓库。',
    suggestedAction: '请检查 GitHub 连接与仓库权限后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'SOURCE_FETCH_FAILED',
  },
  RUNTIME_START_FAILED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.RUNTIME_START,
    productStage: 'RUNTIME_START',
    userMessage: '应用启动失败。',
    suggestedAction: '请检查启动命令与运行配置后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'RUNTIME_START_FAILED',
  },
  CONTAINER_EXITED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.RUNTIME_START,
    productStage: 'RUNTIME_START',
    userMessage: '应用启动后立即退出。',
    suggestedAction: '请检查启动日志与入口命令后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'CONTAINER_EXITED',
  },
  PORT_BIND_FAILED: {
    category: 'USER_CONFIG',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.RUNTIME_START,
    productStage: 'RUNTIME_START',
    userMessage: '应用启动后没有监听系统检测到的端口。',
    suggestedAction: '检查项目启动命令和端口配置后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'PORT_BIND_FAILED',
  },
  RUNTIME_HEALTHCHECK_FAILED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.HEALTHCHECK,
    productStage: 'HEALTHCHECK',
    userMessage: '应用未通过健康检查。',
    suggestedAction: '请确认应用已监听预期端口并能响应健康检查后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'RUNTIME_HEALTHCHECK_FAILED',
  },
  PUBLIC_ENTRY_FAILED: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.PUBLIC_ENTRY,
    productStage: 'PUBLIC_ENTRY',
    userMessage: 'LaunchOS 配置访问入口时出现异常。',
    suggestedAction: 'LaunchOS 上线服务出现异常，请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'PUBLIC_ENTRY_FAILED',
  },
  VERIFY_FAILED: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.VERIFY,
    productStage: 'VERIFY',
    userMessage: '上线检查未通过。',
    suggestedAction: 'LaunchOS 上线服务出现异常，请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'VERIFY_FAILED',
  },
  NO_DEPLOYMENT_WORKER_AVAILABLE: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: 'LaunchOS 上线服务暂时不可用。',
    suggestedAction: 'LaunchOS 上线服务出现异常，请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'NO_DEPLOYMENT_WORKER_AVAILABLE',
  },
  DEPLOY_TIMEOUT: {
    category: 'TRANSIENT',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '上线等待超时。',
    suggestedAction: '请稍后重试。若连续失败，请稍后再试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'DEPLOY_TIMEOUT',
  },
  DEPLOYMENT_TIMEOUT: {
    category: 'TRANSIENT',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '上线等待超时，当前线上版本未改动。',
    suggestedAction: '请稍后重试。若连续失败，请检查应用构建与依赖后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'DEPLOYMENT_TIMEOUT',
  },
  BUILD_IMAGE_FAILED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '应用镜像构建失败。',
    suggestedAction: '请根据构建日志修复依赖或构建命令后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'BUILD_IMAGE_FAILED',
  },
  DEPENDENCY_INSTALL_FAILED: {
    category: 'USER_CODE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '依赖安装失败。',
    suggestedAction: '请根据依赖安装错误修复 package.json / 锁文件后重新上线。',
    retryable: true,
    fixPromptAvailable: true,
    techCode: 'DEPENDENCY_INSTALL_FAILED',
  },
  POSTINSTALL_FAILED: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.BUILD,
    productStage: 'BUILD',
    userMessage: '依赖安装后的初始化脚本失败。',
    suggestedAction: '请稍后重试。若连续失败，请联系 LaunchOS 支持。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'POSTINSTALL_FAILED',
  },
  WORKER_INTERRUPTED: {
    category: 'TRANSIENT',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '上线服务中断。',
    suggestedAction: '请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'WORKER_INTERRUPTED',
  },
  SSH_CONNECTION_FAILED: {
    category: 'INFRASTRUCTURE',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.DEPLOY,
    productStage: 'DEPLOY',
    userMessage: '无法连接托管运行环境。',
    suggestedAction: 'LaunchOS 上线服务出现异常，请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'SSH_CONNECTION_FAILED',
  },
  UNKNOWN_DEPLOYMENT_FAILURE: {
    category: 'PLATFORM',
    title: '上线失败',
    stageLabel: STAGE_LABEL_ZH.UNKNOWN,
    productStage: 'UNKNOWN',
    userMessage: '上线失败。',
    suggestedAction: 'LaunchOS 上线服务出现异常，请稍后重试。',
    retryable: true,
    fixPromptAvailable: false,
    techCode: 'UNKNOWN_DEPLOYMENT_FAILURE',
  },
};

function stageFromLaunchFields(input: {
  currentStage?: string | null;
  currentStep?: string | null;
}): DeploymentFailureProductStage {
  const blob = `${input.currentStage || ''} ${input.currentStep || ''}`.toUpperCase();
  if (blob.includes('VERIFY') || blob.includes('FINAL')) return 'VERIFY';
  if (blob.includes('GATEWAY') || blob.includes('DNS') || blob.includes('PUBLIC') || blob.includes('CERT')) {
    return 'PUBLIC_ENTRY';
  }
  if (blob.includes('HEALTH')) return 'HEALTHCHECK';
  if (blob.includes('BUILD')) return 'BUILD';
  if (blob.includes('DEPLOY') || blob.includes('RUNTIME')) return 'DEPLOY';
  return 'UNKNOWN';
}

/** Strip secrets/tokens/IPs from text shown or copied to users. */
export function redactFailureTextForUser(value: string): string {
  return String(value || '')
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted]')
    .replace(/x-access-token:[^\s@]+/gi, 'x-access-token:[redacted]')
    .replace(/(PASSWORD|SECRET|TOKEN|PRIVATE_KEY|Bearer)\s*[=:]\s*[^\s]+/gi, '$1=[redacted]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[host]')
    .replace(/sha256:[a-f0-9]{16,}/gi, 'sha256:[redacted]')
    .replace(/[0-9a-f]{24,}/gi, '[id]');
}

function extractMissingConfigKeys(raw: string): string[] {
  const text = String(raw || '');
  const matched = text.match(/运行配置[:：]\s*([A-Z0-9_,\s、]+)/i);
  if (!matched?.[1]) return [];
  return matched[1]
    .split(/[、,\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^[A-Z][A-Z0-9_]*$/.test(item));
}

function normalizeTechCode(rawCode: string | null | undefined, rawMessage: string | null | undefined): string {
  const code = String(rawCode || '').trim();
  const message = String(rawMessage || '').trim();
  const blob = `${code} ${message}`;
  if (/RUNTIME_CONFIG_INJECTION_MISMATCH|未能注入|注入校验失败/i.test(blob)) {
    return 'RUNTIME_CONFIG_INJECTION_MISMATCH';
  }
  if (/RUNTIME_CONFIG_MISSING/i.test(blob) || /运行配置/.test(blob) || /AUTH_SECRET|JWT_SECRET|NEXTAUTH/i.test(blob)) {
    return 'RUNTIME_CONFIG_MISSING';
  }
  if (/SOURCE_FETCH|无法访问该代码仓库|重新连接\s*GitHub/i.test(blob)) return 'SOURCE_FETCH_FAILED';
  if (/BUILD_FAIL|vite: not found|npm ERR|exit code 127|构建失败/i.test(blob)) return 'BUILD_FAILED';
  if (/NO_DEPLOYMENT_WORKER|上线服务暂时不可用/i.test(blob)) return 'NO_DEPLOYMENT_WORKER_AVAILABLE';
  if (/DEPLOY_TIMEOUT|DEPLOYMENT_TIMEOUT|上线超时/i.test(blob)) return /DEPLOYMENT_TIMEOUT/i.test(blob) ? 'DEPLOYMENT_TIMEOUT' : 'DEPLOY_TIMEOUT';
  if (/Could not find Prisma Schema|prisma generate|postinstall/i.test(blob) && /npm (error|ERR!)|RUN npm install|DEPENDENCY_INSTALL/i.test(blob)) {
    return 'DEPENDENCY_INSTALL_FAILED';
  }
  if (/DEPENDENCY_INSTALL_FAILED/i.test(blob)) return 'DEPENDENCY_INSTALL_FAILED';
  if (/BUILD_IMAGE|docker build|npm install.*exit|vite: not found/i.test(blob)) return 'BUILD_IMAGE_FAILED';
  if (/VERIFY_FAILED|公网访问检查未通过/i.test(blob)) return 'VERIFY_FAILED';
  if (/PORT_BIND|没有监听/i.test(blob)) return 'PORT_BIND_FAILED';
  if (/HEALTHCHECK|健康检查/i.test(blob)) return 'RUNTIME_HEALTHCHECK_FAILED';
  if (/CONTAINER_EXITED|立即退出/i.test(blob)) return 'CONTAINER_EXITED';
  if (/SSH_CONNECTION|无法连接托管/i.test(blob)) return 'SSH_CONNECTION_FAILED';
  if (/DEPENDENCY_NOT_READY|依赖尚未就绪/i.test(blob)) return 'DEPENDENCY_NOT_READY';
  if (/^[A-Z][A-Z0-9_]{2,80}$/.test(code)) return code;
  return 'UNKNOWN_DEPLOYMENT_FAILURE';
}

function buildFixPrompt(input: {
  presentation: Omit<DeploymentFailurePresentation, 'fixPrompt'>;
  projectName?: string | null;
  missingKeys?: string[];
}): string {
  const keys = input.missingKeys?.length ? input.missingKeys.join(', ') : null;
  return [
    '请帮我排查 LaunchOS 上线失败，并给出最小修改建议。',
    '不要直接改仓库代码，也不要提交或推送。',
    `失败阶段：${input.presentation.stageLabel}`,
    `失败分类：${input.presentation.category}`,
    `用户可见原因：${input.presentation.userMessage}`,
    `建议处理：${input.presentation.suggestedAction}`,
    keys ? `缺失配置键：${keys}` : null,
    input.projectName ? `项目：${input.projectName}` : null,
    `技术码：${input.presentation.techCode}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function presentDeploymentFailure(input: {
  failureCode?: string | null;
  failureMessage?: string | null;
  currentStage?: string | null;
  currentStep?: string | null;
  projectId?: string | null;
  deployableUnitId?: string | null;
  projectName?: string | null;
  missingKeys?: string[];
}): DeploymentFailurePresentation {
  const techCode = normalizeTechCode(input.failureCode, input.failureMessage);
  const mapped = CODE_MAP[techCode] ?? CODE_MAP.UNKNOWN_DEPLOYMENT_FAILURE!;
  const productStage =
    mapped.productStage !== 'UNKNOWN'
      ? mapped.productStage
      : stageFromLaunchFields({
          currentStage: input.currentStage,
          currentStep: input.currentStep,
        });
  const stageLabel = STAGE_LABEL_ZH[productStage];

  const missingKeys =
    input.missingKeys?.length
      ? input.missingKeys
      : extractMissingConfigKeys(`${input.failureCode || ''} ${input.failureMessage || ''}`);

  let userMessage = mapped.userMessage;
  let suggestedAction = mapped.suggestedAction;
  let category = mapped.category;
  let fixPromptAvailable = mapped.fixPromptAvailable;
  if (techCode === 'RUNTIME_CONFIG_MISSING' && missingKeys.length > 0) {
    userMessage = `上线前还缺少必要的运行配置：${missingKeys.join('、')}。`;
    suggestedAction = `请在运行配置中填写 ${missingKeys.join('、')} 后重新上线。`;
  }
  if (techCode === 'DEPENDENCY_INSTALL_FAILED') {
    const raw = `${input.failureCode || ''} ${input.failureMessage || ''}`;
    if (/Could not find Prisma Schema|prisma generate/i.test(raw)) {
      category = 'PLATFORM';
      fixPromptAvailable = false;
      userMessage =
        '依赖安装失败：构建环境在安装依赖时未准备好 Prisma schema。';
      suggestedAction =
        'LaunchOS 已修复该构建步骤。请直接重新上线，无需修改项目代码。';
    } else if (/ERESOLVE|peer dep/i.test(raw)) {
      userMessage = '依赖安装失败：项目依赖之间存在版本冲突。';
      suggestedAction = '请在本地修复 package.json / 锁文件中的依赖冲突后重新上线。';
    } else if (/ETARGET|notarget|404|ENOTFOUND.*package/i.test(raw)) {
      userMessage = '依赖安装失败：找不到某个 npm 包。';
      suggestedAction = '请检查 package.json 中的包名与版本后重新上线。';
    } else {
      userMessage = '依赖安装失败。';
      suggestedAction = '请根据依赖安装错误检查 package.json 与锁文件后重新上线。';
    }
  }

  // Prefer human message when it is already safe Chinese product copy for config misses.
  const rawMsg = String(input.failureCode || input.failureMessage || '');
  if (techCode === 'RUNTIME_CONFIG_MISSING' && /运行配置/.test(rawMsg)) {
    userMessage = redactFailureTextForUser(rawMsg.split('\n')[0] || userMessage);
  }

  const configPath =
    input.projectId && input.deployableUnitId
      ? `/projects/${input.projectId}/units/${input.deployableUnitId}/config`
      : input.projectId
        ? `/projects/${input.projectId}`
        : null;

  const base = {
    category,
    title: '上线失败',
    stageLabel,
    productStage,
    userMessage: redactFailureTextForUser(userMessage),
    suggestedAction: redactFailureTextForUser(suggestedAction),
    retryable: mapped.retryable,
    fixPromptAvailable,
    techCode,
    configPath,
  };

  return {
    ...base,
    fixPrompt: base.fixPromptAvailable
      ? buildFixPrompt({
          presentation: base,
          projectName: input.projectName,
          missingKeys,
        })
      : null,
  };
}

export function extractNestFailurePayload(error: unknown): {
  code: string | null;
  message: string;
  missingKeys: string[];
  configPath: string | null;
  deployableUnitId: string | null;
} {
  if (error && typeof error === 'object' && 'getResponse' in error && typeof (error as { getResponse?: unknown }).getResponse === 'function') {
    try {
      const resp = (error as { getResponse: () => unknown }).getResponse();
      if (typeof resp === 'string') {
        return {
          code: null,
          message: resp,
          missingKeys: extractMissingConfigKeys(resp),
          configPath: null,
          deployableUnitId: null,
        };
      }
      if (resp && typeof resp === 'object') {
        const body = resp as Record<string, unknown>;
        const code = typeof body.code === 'string' ? body.code : null;
        const message =
          typeof body.message === 'string'
            ? body.message
            : Array.isArray(body.message)
              ? body.message.map(String).join('; ')
              : error instanceof Error
                ? error.message
                : '上线执行失败';
        const missing = Array.isArray(body.missing)
          ? body.missing
              .map((item) =>
                item && typeof item === 'object' && 'key' in item
                  ? String((item as { key: unknown }).key)
                  : '',
              )
              .filter(Boolean)
          : extractMissingConfigKeys(message);
        const configPath = typeof body.configPath === 'string' ? body.configPath : null;
        const fromPath = configPath?.match(/\/units\/([^/]+)\/config/)?.[1] ?? null;
        return { code, message, missingKeys: missing, configPath, deployableUnitId: fromPath };
      }
    } catch {
      // fall through
    }
  }
  const message = error instanceof Error ? error.message : '上线执行失败';
  const asciiCode = message.match(/^([A-Z][A-Z0-9_]{2,80}):/)?.[1] ?? null;
  return {
    code: asciiCode,
    message,
    missingKeys: extractMissingConfigKeys(message),
    configPath: null,
    deployableUnitId: null,
  };
}
