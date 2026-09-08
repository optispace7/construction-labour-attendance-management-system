import { Body, Controller, Delete, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DeviceStatus } from '../../common/enums';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DevicesService } from './devices.service';
import { RequirePermissions } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

class UpdateDeviceDto {
  @IsOptional()
  @IsEnum(DeviceStatus)
  status?: DeviceStatus;

  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

@ApiTags('devices')
@ApiBearerAuth()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermissions(Permission.DEVICE_MANAGE)
  list(
    @CurrentUser() user: AuthUser,
    @Query('siteId') siteId?: string,
    @Query('status') status?: DeviceStatus,
  ) {
    return this.devices.list(user, siteId, status);
  }

  @Patch(':id')
  @RequirePermissions(Permission.DEVICE_MANAGE)
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateDeviceDto) {
    return this.devices.update(user, id, dto);
  }

  // Only for devices that never marked attendance — see DevicesService.remove.
  @Delete(':id')
  @RequirePermissions(Permission.DEVICE_MANAGE)
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.devices.remove(user, id);
  }
}
