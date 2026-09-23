import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { DEVICE_AUTH_KEY, DEVICE_EXEMPT_KEY } from '../rbac/rbac.decorators';
import { DeviceAuthService } from '../../modules/devices/device-auth.service';
import { Errors } from '../errors/app.exception';
import { AuthUser } from './auth-user.interface';
import { APP_VERSION_HEADER } from '../app-version';

/**
 * Two layers of device enforcement:
 *
 * 1. Routes marked @RequiresDevice() (attendance/sync) always need headers
 *    X-Device-Id and X-Device-Token referring to an AUTHORIZED device.
 * 2. Every authenticated, non-Super-Admin user must work from an approved
 *    device (mobile phone or web browser). Until an admin/super admin
 *    authorizes the device, all API calls except @Public and @DeviceExempt
 *    (auth/device registration) are rejected — so logging in shows nothing.
 */
@Injectable()
export class DeviceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly deviceAuth: DeviceAuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requires = this.reflector.getAllAndOverride<boolean>(DEVICE_AUTH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const exempt = this.reflector.getAllAndOverride<boolean>(DEVICE_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<Request>();
    const user = (req as Request & { user?: AuthUser }).user;

    const roleNeedsDevice = !!user && user.role !== 'SUPER_ADMIN' && !exempt;
    if (!requires && !roleNeedsDevice) return true;

    const deviceId = req.headers['x-device-id'] as string;
    const token = req.headers['x-device-token'] as string;
    if (!deviceId || !token) throw Errors.deviceNotAuthorized();

    const ok = await this.deviceAuth.validateToken(
      deviceId,
      token,
      req.headers[APP_VERSION_HEADER],
    );
    if (!ok) throw Errors.deviceNotAuthorized();

    (req as Request & { deviceId: string }).deviceId = deviceId;
    return true;
  }
}
