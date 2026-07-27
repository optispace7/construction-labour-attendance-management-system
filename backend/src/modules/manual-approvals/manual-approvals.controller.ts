import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ManualApprovalStatus } from '@prisma/client';
import { ManualApprovalsService } from './manual-approvals.service';
import { ReviewManualDto } from './dto/manual-approval.dto';
import { RequirePermissions } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

/**
 * The queue of hand-typed punches waiting on a Safety Officer.
 *
 * Reachable from both the mobile app (the Safety Officer is on site, not at a
 * desk) and the admin panel, which is why nothing here is device-gated: a
 * decision about attendance is not a scan.
 */
@ApiTags('manual-approvals')
@ApiBearerAuth()
@Controller('manual-approvals')
export class ManualApprovalsController {
  constructor(private readonly service: ManualApprovalsService) {}

  @Get()
  @RequirePermissions(Permission.MANUAL_ATTENDANCE_REVIEW)
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: ManualApprovalStatus,
    @Query('siteId') siteId?: string,
  ) {
    return this.service.list(user, status, siteId);
  }

  @Get('pending-count')
  @RequirePermissions(Permission.MANUAL_ATTENDANCE_REVIEW)
  pendingCount(@CurrentUser() user: AuthUser) {
    return this.service.pendingCount(user);
  }

  @Post(':id/approve')
  @RequirePermissions(Permission.MANUAL_ATTENDANCE_REVIEW)
  approve(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReviewManualDto) {
    return this.service.approve(user, id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions(Permission.MANUAL_ATTENDANCE_REVIEW)
  reject(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: ReviewManualDto) {
    return this.service.reject(user, id, dto);
  }
}
