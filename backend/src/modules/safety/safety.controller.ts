import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SafetyMetric } from '@prisma/client';
import { SafetyService } from './safety.service';
import { SafetyPeriod, SaveDailyDto, UpsertMetricDto, WasteTypeDto } from './dto/safety.dto';
import { RequirePermissions } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

@ApiTags('safety')
@ApiBearerAuth()
@Controller('safety')
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  /** The metric catalogue — labels, kinds and groups that drive both forms. */
  @Get('catalog')
  @RequirePermissions(Permission.SAFETY_VIEW)
  catalog() {
    return this.safety.catalog();
  }

  /** One day's board. `siteId=all` aggregates and is read-only. */
  @Get('daily')
  @RequirePermissions(Permission.SAFETY_VIEW)
  daily(
    @CurrentUser() user: AuthUser,
    @Query('date') date?: string,
    @Query('siteId') siteId?: string,
  ) {
    return this.safety.daily(user, { date, siteId });
  }

  @Put('daily')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  saveDaily(@CurrentUser() user: AuthUser, @Body() dto: SaveDailyDto) {
    return this.safety.saveDaily(user, dto);
  }

  /** Edit one item on one day. */
  @Post('metric')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  upsertMetric(@CurrentUser() user: AuthUser, @Body() dto: UpsertMetricDto) {
    return this.safety.upsertMetric(user, dto);
  }

  /** Put one item back to "not filled in". */
  @Delete('metric')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  deleteMetric(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId: string,
    @Query('date') date: string,
    @Query('metric') metric: SafetyMetric,
  ) {
    return this.safety.deleteMetric(user, { siteId, date, metric });
  }

  /**
   * The waste dropdown. Reading it is part of reading the sheet; adding,
   * renaming and removing belong to whoever fills the sheet in — the Safety
   * Officer — which is what SAFETY_MANAGE already means.
   */
  @Get('waste-types')
  @RequirePermissions(Permission.SAFETY_VIEW)
  wasteTypes(@CurrentUser() user: AuthUser) {
    return this.safety.wasteTypes(user);
  }

  @Post('waste-types')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  createWasteType(@CurrentUser() user: AuthUser, @Body() dto: WasteTypeDto) {
    return this.safety.createWasteType(user, dto);
  }

  @Patch('waste-types/:id')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  updateWasteType(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: WasteTypeDto,
  ) {
    return this.safety.updateWasteType(user, id, dto);
  }

  /** Removes an unused type outright; retires one that has figures behind it. */
  @Delete('waste-types/:id')
  @RequirePermissions(Permission.SAFETY_MANAGE)
  deleteWasteType(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.safety.deleteWasteType(user, id);
  }

  /** One item across a date range — the per-item "view all dates". */
  @Get('history')
  @RequirePermissions(Permission.SAFETY_VIEW)
  history(
    @CurrentUser() user: AuthUser,
    @Query('metric') metric: SafetyMetric,
    @Query('siteId') siteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.safety.history(user, { metric, siteId, from, to });
  }

  /**
   * The statistics board as a PDF. Streams the bytes so the panel can hand them
   * straight to a download and the mobile app to a share sheet.
   */
  @Get('stats/pdf')
  @RequirePermissions(Permission.SAFETY_VIEW)
  async statsPdf(
    @CurrentUser() user: AuthUser,
    @Res() res: Response,
    @Query('period') period?: SafetyPeriod,
    @Query('date') date?: string,
    @Query('siteId') siteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const { buffer, filename } = await this.safety.statsPdf(user, {
      period,
      date,
      siteId,
      from,
      to,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.end(buffer);
  }

  /**
   * Everything the statistics board draws.
   *
   * `period=custom` reads `from`/`to` and ignores `date`; the other three derive
   * their window from `date`.
   */
  @Get('stats')
  @RequirePermissions(Permission.SAFETY_VIEW)
  stats(
    @CurrentUser() user: AuthUser,
    @Query('period') period?: SafetyPeriod,
    @Query('date') date?: string,
    @Query('siteId') siteId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.safety.stats(user, { period, date, siteId, from, to });
  }
}
