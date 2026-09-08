import { Global, Module } from '@nestjs/common';
import { D1Service } from './d1.service';

/**
 * Global, like PrismaModule was, so a service asks for the database without
 * every module having to import it.
 */
@Global()
@Module({
  providers: [D1Service],
  exports: [D1Service],
})
export class D1Module {}
