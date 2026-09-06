import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { DeviceAuthService } from '../devices/device-auth.service';
import { DeviceRegisterDto, DeviceTokenDto } from './dto/auth.dto';
import { DeviceExempt, Public } from '../../common/rbac/rbac.decorators';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

@ApiTags('auth')
@Controller('auth')
// Auth endpoints stay reachable from unapproved devices — otherwise a pending
// device could never register itself or poll its approval status.
@DeviceExempt()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly deviceAuth: DeviceAuthService,
  ) {}

  // Signing in, refreshing, signing out and resetting a password are Better
  // Auth's now, under /api/better-auth. They are gone from here rather than
  // left as a second way in: two login endpoints against one set of accounts
  // is how one of them quietly keeps working after the other is secured.
  //
  // What remains is what Better Auth has no opinion about — who this person is
  // to CLAMS, and whether the device they are on has been approved.

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser('userId') userId: string) {
    return this.auth.me(userId);
  }

  @ApiBearerAuth()
  @Post('device/register')
  registerDevice(@CurrentUser() user: AuthUser, @Body() dto: DeviceRegisterDto) {
    return this.deviceAuth.register(
      user.organizationId,
      dto.deviceUid,
      dto.platform,
      dto.label,
      user.userId,
      user.role,
      user.email ?? undefined,
    );
  }

  @ApiBearerAuth()
  @Get('device/status')
  deviceStatus(@CurrentUser() user: AuthUser, @Query('uid') uid: string) {
    return this.deviceAuth.status(user.organizationId, uid);
  }

  @ApiBearerAuth()
  @Post('device/token')
  deviceToken(@CurrentUser() user: AuthUser, @Body() dto: DeviceTokenDto) {
    return this.deviceAuth.issueToken(user.organizationId, dto.deviceId);
  }
}
