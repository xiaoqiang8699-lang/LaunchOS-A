import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { assertAccountCanUseProduct } from '@launchos/domain';
import { PrismaService } from '../database/prisma.service';
import type { AuthUser } from './auth.types';

type JwtPayload = {
  sub: string;
  email: string;
  sid?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const token = extractBearerToken(request.headers.authorization);

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    try {
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, accountStatus: true },
      });

      if (!user) {
        throw new UnauthorizedException();
      }
      const account = assertAccountCanUseProduct(user.accountStatus);
      if (!account.allowed) {
        throw new UnauthorizedException(account.message);
      }

      if (payload.sid) {
        const session = await this.prisma.authSession.findUnique({
          where: { id: payload.sid },
          select: { id: true, userId: true, revokedAt: true },
        });
        if (!session || session.userId !== user.id || session.revokedAt) {
          throw new UnauthorizedException('Invalid access token');
        }
        request.user = { id: user.id, email: user.email, name: user.name, sessionId: session.id };
      } else {
        request.user = { id: user.id, email: user.email, name: user.name };
      }
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid access token');
    }
  }
}

function extractBearerToken(header?: string): string | undefined {
  if (!header) {
    return undefined;
  }

  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return undefined;
  }

  return token;
}
