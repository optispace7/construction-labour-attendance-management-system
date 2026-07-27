import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AttendanceService } from './attendance.service';
import { SessionAdminService } from './session-admin.service';
import { SyncService } from './sync.service';
import { ConfirmDto, TapDto } from './dto/attendance.dto';
import {
  BulkLogoutDto,
  BulkReopenDto,
  DeleteSessionDto,
  EditSessionDto,
} from './dto/session-admin.dto';
import { RequirePermissions, RequiresDevice } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';
import { IsArray, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class SyncDto {
  @IsUUID()
  deviceId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TapDto)
  events!: TapDto[];
}

@ApiTags('attendance')
@ApiBearerAuth()
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly sync: SyncService,
    private readonly sessionAdmin: SessionAdminService,
  ) {}

  @Post('tap')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  tap(@CurrentUser() user: AuthUser, @Body() dto: TapDto, @Req() req: Request) {
    return this.attendance.handleTap(user.organizationId, dto, {
      deviceId: dto.deviceId,
      ip: req.ip,
    });
  }

  @Post('confirm')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  confirm(@CurrentUser() user: AuthUser, @Body() dto: ConfirmDto, @Req() req: Request) {
    return this.attendance.confirm(user.organizationId, dto.eventId, {
      deviceId: (req.headers['x-device-id'] as string) ?? '',
      ip: req.ip,
    });
  }

  // Scanner-side state reads. Both sit on ATTENDANCE_MARK (not ATTENDANCE_VIEW)
  // because a watchman device needs them to decide in/out, and neither exposes
  // anything beyond "this worker is currently logged in".
  @Get('worker-state')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  workerState(@CurrentUser() user: AuthUser, @Query('workerId') workerId: string) {
    return this.attendance.workerTapState(user.organizationId, workerId);
  }

  @Get('open-sessions')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  openSessions(@CurrentUser() user: AuthUser) {
    return this.attendance.openSessions(user.organizationId);
  }

  // The scanner's copy of the site's tap policy — cooldown and safety gap.
  // /sites/:id/settings needs SETTINGS_MANAGE, which a watchman does not have,
  // so the app reads its rules here instead of hardcoding them.
  @Get('site-config')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  siteConfig(@CurrentUser() user: AuthUser, @Query('siteId') siteId: string) {
    return this.attendance.siteConfig(user, siteId);
  }

  @Get('active')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  active(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId?: string,
    @Query('category') category?: string,
  ) {
    return this.attendance.activeSessions(user, siteId, category);
  }

  @Get('logged-out')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  loggedOut(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId?: string,
    @Query('category') category?: string,
    @Query('date') date?: string,
  ) {
    return this.attendance.loggedOutToday(user, siteId, category, date);
  }

  @Get('dashboard-stats')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  dashboardStats(@CurrentUser() user: AuthUser) {
    return this.attendance.dashboardStats(user);
  }

  // from/to (YYYY-MM-DD) drive the manpower panel only; the vendor trend below
  // it stays a fixed 30-day window. Both default to the last seven days.
  @Get('dashboard-charts')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  dashboardCharts(
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.dashboardCharts(user, { from, to });
  }

  @Get('day-summary')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  daySummary(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId?: string,
    @Query('date') date?: string,
    @Query('category') category?: string,
  ) {
    return this.attendance.daySummary(user, siteId, date, category);
  }

  @Get('worker/:workerId/summary')
  @RequirePermissions(Permission.ATTENDANCE_VIEW)
  summary(
    @CurrentUser() user: AuthUser,
    @Param('workerId') workerId: string,
    @Query('month') month: string,
  ) {
    return this.attendance.workerSummary(user.organizationId, workerId, month);
  }

  // ---------------- Fix attendance (ATTENDANCE_EDIT — Super Admin only) ----------------
  // Repairs to already-recorded sessions: wrong worker, wrong times, phantom
  // rows from double scans, and the end-of-day sweep when nobody scanned out.

  @Get('admin/day')
  @RequirePermissions(Permission.ATTENDANCE_EDIT)
  adminDay(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('siteId') siteId?: string,
  ) {
    return this.sessionAdmin.day(user, date, siteId);
  }

  @Patch('admin/sessions/:id')
  @RequirePermissions(Permission.ATTENDANCE_EDIT)
  adminEditSession(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: EditSessionDto,
  ) {
    return this.sessionAdmin.edit(user, id, dto);
  }

  @Delete('admin/sessions/:id')
  @RequirePermissions(Permission.ATTENDANCE_EDIT)
  adminDeleteSession(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DeleteSessionDto,
  ) {
    return this.sessionAdmin.remove(user, id, dto.reason);
  }

  // Pass dryRun to preview the sweep; the admin panel shows that preview in the
  // confirmation dialog before anything is written.
  @Post('admin/bulk-logout')
  @RequirePermissions(Permission.ATTENDANCE_EDIT)
  adminBulkLogout(@CurrentUser() user: AuthUser, @Body() dto: BulkLogoutDto) {
    return this.sessionAdmin.bulkLogout(user, dto);
  }

  // The other direction: undo a logout that should never have happened and put
  // those people back on site. Also previews itself through dryRun.
  @Post('admin/bulk-reopen')
  @RequirePermissions(Permission.ATTENDANCE_EDIT)
  adminBulkReopen(@CurrentUser() user: AuthUser, @Body() dto: BulkReopenDto) {
    return this.sessionAdmin.bulkReopen(user, dto);
  }

  @Post('/sync')
  @RequiresDevice()
  @RequirePermissions(Permission.ATTENDANCE_MARK)
  syncBatch(@CurrentUser() user: AuthUser, @Body() dto: SyncDto, @Req() req: Request) {
    return this.sync.ingest(user.organizationId, dto.deviceId, dto.events, {
      deviceId: dto.deviceId,
      ip: req.ip,
    });
  }
}
