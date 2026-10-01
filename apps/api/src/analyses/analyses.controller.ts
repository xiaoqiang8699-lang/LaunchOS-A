import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/auth.types';
import { AnalysesService } from './analyses.service';

@Controller('projects')
@UseGuards(JwtAuthGuard)
export class AnalysesController {
  constructor(private readonly analysesService: AnalysesService) {}

  @Post(':id/ai/analyze')
  analyze(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.analysesService.analyze(user.id, projectId);
  }

  @Get(':id/ai/analysis')
  getLatest(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.analysesService.getLatest(user.id, projectId);
  }

  @Post(':id/code-analysis')
  analyzeCode(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.analysesService.analyzeCode(user.id, projectId);
  }

  @Get(':id/code-analysis')
  getLatestCodeAnalysis(@CurrentUser() user: AuthUser, @Param('id') projectId: string) {
    return this.analysesService.getLatestCodeAnalysis(user.id, projectId);
  }
}
