import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../rbac/rbac.decorators';
import { D1Service } from '../../infra/d1/d1.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly d1: D1Service) {}

  /** Server time — the app compares this with the phone clock before punches. */
  @Public()
  @Get('time')
  time() {
    return { now: new Date().toISOString() };
  }

  @Public()
  @Get()
  async check() {
    let db = 'down';
    try {
      await this.d1.d1.prepare('SELECT 1').first();
      db = 'up';
    } catch {
      db = 'down';
    }
    return { status: db === 'up' ? 'ok' : 'degraded', db };
  }
}
