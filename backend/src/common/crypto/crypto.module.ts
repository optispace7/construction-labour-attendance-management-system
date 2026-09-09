import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { IdentityService } from '../better-auth/identity.service';

@Global()
@Module({
  providers: [CryptoService, IdentityService],
  exports: [CryptoService, IdentityService],
})
export class CryptoModule {}
