import {
  Body,
  Controller,
  Get,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { OnboardingService } from './onboarding.service';
import { ZIP_INTAKE_LIMITS } from '@launchos/shared';

@Controller('onboarding')
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get()
  state(@CurrentUser() user: AuthUser) {
    return this.onboarding.getState(user.id);
  }

  @Post('source/viewed')
  sourceViewed(@CurrentUser() user: AuthUser) {
    return this.onboarding.trackSourceViewed(user.id);
  }

  @Post('source')
  connect(
    @CurrentUser() user: AuthUser,
    @Body()
    body: {
      fullName: string;
      cloneUrl: string;
      branch?: string;
      connectionId: string;
      providerRepositoryId: string;
      isPrivate?: boolean;
    },
  ) {
    return this.onboarding.connectSource(user.id, body);
  }

  @Post('source/public')
  connectPublic(
    @CurrentUser() user: AuthUser,
    @Body() body: { cloneUrl: string; branch?: string },
  ) {
    return this.onboarding.connectPublicSource(user.id, body);
  }

  @Post('source/zip')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: ZIP_INTAKE_LIMITS.maxZipBytes, files: 1 },
    }),
  )
  connectZip(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    return this.onboarding.connectZipSource(user.id, file);
  }

  @Post('analyze')
  analyze(@CurrentUser() user: AuthUser) {
    return this.onboarding.analyze(user.id);
  }

  @Post('root')
  chooseRoot(@CurrentUser() user: AuthUser, @Body() body: { rootPath: string }) {
    return this.onboarding.chooseRoot(user.id, body.rootPath);
  }

  @Post('plan')
  plan(@CurrentUser() user: AuthUser) {
    return this.onboarding.viewPlan(user.id);
  }

  @Post('confirm')
  confirm(@CurrentUser() user: AuthUser) {
    return this.onboarding.confirmPlan(user.id);
  }

  @Post('launch')
  launch(@CurrentUser() user: AuthUser) {
    return this.onboarding.startLaunch(user.id);
  }

  @Get('launch')
  launchStatus(@CurrentUser() user: AuthUser) {
    return this.onboarding.launchStatus(user.id);
  }

  @Post('complete')
  complete(@CurrentUser() user: AuthUser, @Body() body: { reason?: 'SUCCESS' | 'SKIP' }) {
    return this.onboarding.complete(user.id, body?.reason ?? 'SKIP');
  }

  @Post('defer')
  defer(@CurrentUser() user: AuthUser) {
    return this.onboarding.defer(user.id);
  }
}
