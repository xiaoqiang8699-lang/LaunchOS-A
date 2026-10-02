import { Injectable, Logger } from '@nestjs/common';
import { redactText } from './ai-sanitize';

export abstract class AIProvider {
  abstract readonly name: string;
  abstract generateText(prompt: string): Promise<string>;
}

/**
 * Default provider: deterministic local analysis text.
 * Does not call external models. Safe for Beta without API keys.
 */
@Injectable()
export class LocalHeuristicAIProvider extends AIProvider {
  readonly name = 'local-heuristic';

  async generateText(prompt: string): Promise<string> {
    const clean = redactText(prompt);
    // Extract FACTS block if present; otherwise return a short safe summary.
    const factsMatch = clean.match(/FACTS:\s*([\s\S]*?)(?:\n\n|$)/i);
    const facts = (factsMatch?.[1] || clean).trim().slice(0, 1200);
    return `基于平台内部运营数据的分析摘要：\n${facts}\n\n说明：当前使用本地启发式分析引擎，输出仅供管理员参考，不会自动执行任何运营动作。`;
  }
}

/**
 * Optional HTTP provider. Enabled when LAUNCHOS_AI_ENDPOINT is set.
 * Expects POST { prompt } -> { text }.
 */
@Injectable()
export class HttpAIProvider extends AIProvider {
  readonly name = 'http';
  private readonly logger = new Logger(HttpAIProvider.name);

  async generateText(prompt: string): Promise<string> {
    const endpoint = process.env.LAUNCHOS_AI_ENDPOINT?.trim();
    if (!endpoint) {
      throw new Error('LAUNCHOS_AI_ENDPOINT not configured');
    }
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(process.env.LAUNCHOS_AI_TOKEN
          ? { authorization: `Bearer ${process.env.LAUNCHOS_AI_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ prompt: redactText(prompt) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`HTTP AI provider failed: ${res.status} ${body.slice(0, 200)}`);
      throw new Error(`AI_PROVIDER_HTTP_${res.status}`);
    }
    const json = (await res.json().catch(() => ({}))) as { text?: string; content?: string };
    return redactText(String(json.text || json.content || ''));
  }
}

@Injectable()
export class AIProviderRouter extends AIProvider {
  readonly name = 'router';
  private readonly logger = new Logger(AIProviderRouter.name);

  constructor(
    private readonly local: LocalHeuristicAIProvider,
    private readonly http: HttpAIProvider,
  ) {
    super();
  }

  async generateText(prompt: string): Promise<string> {
    if (process.env.LAUNCHOS_AI_ENDPOINT?.trim()) {
      try {
        return await this.http.generateText(prompt);
      } catch (error) {
        this.logger.warn(
          `Falling back to local AI provider: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    }
    return this.local.generateText(prompt);
  }
}
