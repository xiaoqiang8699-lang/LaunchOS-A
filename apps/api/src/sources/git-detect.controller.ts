import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import { GitService, isPlaceholderGitUrl } from '@launchos/git';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { DetectGitDto } from './dto/detect-git.dto';

@Controller('git')
@UseGuards(JwtAuthGuard)
export class GitDetectController {
  private readonly git = new GitService();

  @Post('detect')
  async detect(@CurrentUser() _user: AuthUser, @Body() dto: DetectGitDto) {
    const url = dto.url.trim();
    if (!url) {
      throw new BadRequestException('请填写代码地址');
    }
    if (isPlaceholderGitUrl(url)) {
      return {
        url,
        owner: 'example',
        name: 'alpha-demo',
        defaultBranch: 'main',
        reachable: true,
        autoDetected: true,
        message: '自动检测默认分支：main',
      };
    }

    const detected = await this.git.detectRepository(url);
    if (!detected.reachable || !detected.defaultBranch) {
      const raw = detected.errorMessage || '';
      if (isPrivateRepoError(raw)) {
        throw new BadRequestException('这个代码仓库需要授权才能访问。');
      }
      throw new BadRequestException(
        '无法读取代码仓库，请确认地址是否正确、仓库是否公开可访问。',
      );
    }

    return {
      url: detected.url,
      owner: detected.owner,
      name: detected.name,
      defaultBranch: detected.defaultBranch,
      reachable: true,
      autoDetected: true,
      message: `自动检测默认分支：${detected.defaultBranch}`,
    };
  }
}

function isPrivateRepoError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('authentication') ||
    lower.includes('permission denied') ||
    lower.includes('could not read username') ||
    lower.includes('invalid credentials') ||
    lower.includes('access denied') ||
    lower.includes('private repository') ||
    lower.includes('403') ||
    lower.includes('401')
  );
}
