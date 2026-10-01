import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AlphaTestsService } from './alpha-tests.service';

@Controller('alpha-tests')
@UseGuards(JwtAuthGuard)
export class AlphaTestsController {
  constructor(private readonly alpha: AlphaTestsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.alpha.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: { projectId?: string; projectType?: string; framework?: string; dependencies?: string },
  ) {
    return this.alpha.create(user.id, body ?? {});
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alpha.get(user.id, id);
  }

  @Post(':id/project')
  bindProject(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { projectId: string; projectType?: string; framework?: string; dependencies?: string },
  ) {
    return this.alpha.bindProject(user.id, id, body);
  }

  @Post(':id/start')
  start(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alpha.markStarted(user.id, id);
  }

  @Post('source-connection-p1')
  noteSourceP1(@CurrentUser() user: AuthUser) {
    return this.alpha.noteSourceConnectionP1Frictions(user.id);
  }

  @Post(':id/friction')
  friction(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { stage: string; note: string },
  ) {
    return this.alpha.addFriction(user.id, id, body);
  }

  @Post(':id/debrief')
  debrief(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body()
    body: {
      biggestFriction: string;
      confusingCopy: string;
      explainedTechnicalConcept: boolean;
      viewedTechnicalDetails: boolean;
      failureCause?: string | null;
    },
  ) {
    return this.alpha.recordDebrief(user.id, id, body);
  }

  @Post(':id/interventions')
  intervene(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { stage: string; reason: string; actionTaken: string; category?: string; resolved?: boolean },
  ) {
    return this.alpha.addIntervention(user.id, id, body);
  }

  @Post(':id/feedback')
  feedback(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body()
    body: {
      knewNextStep: number;
      billingClear: number;
      failureUnderstandable: number;
      neededHelp: number;
      wouldContinue: number;
      freeFeedback?: string;
    },
  ) {
    return this.alpha.submitFeedback(user.id, id, body);
  }

  @Post(':id/health')
  health(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.alpha.checkHealth(user.id, id);
  }
}
