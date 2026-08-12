import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CorrectionStatus } from '@prisma/client';
import { CorrectionsService } from './corrections.service';
import { CreateCorrectionDto, ReviewCorrectionDto } from './dto/correction.dto';
import { RequirePermissions } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

@ApiTags('corrections')
@ApiBearerAuth()
@Controller('corrections')
export class CorrectionsController {
  constructor(private readonly corrections: CorrectionsService) {}

  @Post()
  @RequirePermissions(Permission.CORRECTION_REQUEST)
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCorrectionDto) {
    return this.corrections.create(user, dto);
  }

  @Get()
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: CorrectionStatus,
    @Query('siteId') siteId?: string,
    @Query('workerId') workerId?: string,
    // The Super Admin's after-the-fact review: the corrections that were
    // applied by their own author, with nobody else in the loop.
    @Query('autoApplied') autoApplied?: string,
  ) {
    return this.corrections.list(
      user,
      status,
      siteId,
      workerId,
      autoApplied === undefined ? undefined : autoApplied === 'true',
    );
  }

  @Get(':id')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.corrections.get(user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(Permission.CORRECTION_APPROVE)
  approve(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReviewCorrectionDto,
  ) {
    return this.corrections.approve(user, id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.CORRECTION_APPROVE)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReviewCorrectionDto) {
    return this.corrections.reject(user, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions(Permission.CORRECTION_REQUEST)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.corrections.cancel(user, id);
  }
}
