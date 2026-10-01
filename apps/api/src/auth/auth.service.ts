import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WorkspaceRole } from '@launchos/database';
import { assertAccountCanUseProduct, isFirstTimeUser, isOrdinaryUserProject, markOnboardingCompleted } from '@launchos/domain';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionEngineService } from '../billing/subscription-engine.service';
import type { PublicUser, PublicWorkspace } from './auth.types';
import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly billing: SubscriptionEngineService,
  ) {}

  async register(dto: RegisterDto): Promise<{ user: PublicUser; workspace: PublicWorkspace }> {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });

    if (existing) {
      throw new ConflictException('该邮箱已经注册');
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const name = dto.name.trim();

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email,
          name,
          passwordHash,
          hasCompletedOnboarding: false,
        },
      });

      const workspace = await tx.workspace.create({
        data: {
          name: `${name} 的工作空间`,
          ownerId: user.id,
        },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: WorkspaceRole.OWNER,
        },
      });

      return { user, workspace };
    });

    await this.billing.ensureDefaultFree(result.workspace.id, result.user.id);

    return {
      user: toPublicUser(result.user, 0),
      workspace: toPublicWorkspace(result.workspace),
    };
  }

  async login(dto: LoginDto, userAgent?: string): Promise<{ accessToken: string; user: PublicUser }> {
    const email = normalizeEmail(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }

    const matches = await bcrypt.compare(dto.password, user.passwordHash);
    if (!matches) {
      throw new UnauthorizedException('邮箱或密码不正确');
    }
    const account = assertAccountCanUseProduct(user.accountStatus);
    if (!account.allowed) {
      throw new UnauthorizedException(account.message);
    }

    const session = await this.prisma.authSession.create({
      data: {
        userId: user.id,
        userAgent: userAgent?.slice(0, 200) ?? null,
      },
    });
    const signedIn = await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      email: user.email,
      sid: session.id,
    });

    const realProjectCount = await this.realProjectCount(user.id);
    return {
      accessToken,
      user: toPublicUser(signedIn, realProjectCount),
    };
  }

  async changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const matches = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!matches) throw new UnauthorizedException('当前密码不正确');
    if (nextPassword.trim().length < 8) {
      throw new UnauthorizedException('新密码至少 8 位');
    }
    const passwordHash = await bcrypt.hash(nextPassword, 10);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    return { ok: true };
  }

  async updateProfileName(userId: string, name: string): Promise<PublicUser> {
    const trimmed = name.trim();
    if (!trimmed) throw new UnauthorizedException('姓名不能为空');
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { name: trimmed },
    });
    return toPublicUser(user, await this.realProjectCount(user.id));
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return toPublicUser(user, await this.realProjectCount(user.id));
  }

  async completeOnboarding(userId: string): Promise<PublicUser> {
    const marked = markOnboardingCompleted({ reason: 'SKIP', now: new Date().toISOString() });
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        hasCompletedOnboarding: true,
        onboardingStatus: marked.onboardingStatus,
        onboardingCompletedAt: new Date(marked.onboardingCompletedAt),
      },
    });
    return toPublicUser(user, await this.realProjectCount(user.id));
  }

  private async realProjectCount(userId: string): Promise<number> {
    const projects = await this.prisma.project.findMany({
      where: { workspace: { members: { some: { userId } } } },
      select: { isDemo: true, name: true, slug: true },
    });
    return projects.filter((project) => isOrdinaryUserProject(project)).length;
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicUser(
  user: {
    id: string;
    email: string;
    name: string;
    hasCompletedOnboarding: boolean;
    onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
    isInternal: boolean;
    platformRole: 'USER' | 'PLATFORM_ADMIN';
    createdAt: Date;
    updatedAt: Date;
  },
  realProjectCount = 0,
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    hasCompletedOnboarding: user.hasCompletedOnboarding,
    onboardingStatus: user.onboardingStatus,
    isInternal: user.isInternal,
    platformRole: user.platformRole,
    isFirstTimeUser: isFirstTimeUser({ onboardingStatus: user.onboardingStatus, realProjectCount }),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toPublicWorkspace(workspace: {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  updatedAt: Date;
}): PublicWorkspace {
  return {
    id: workspace.id,
    name: workspace.name,
    ownerId: workspace.ownerId,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}
