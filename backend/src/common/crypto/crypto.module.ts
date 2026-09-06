import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { PasswordHashService } from './password-hash.service';
import { IdentityService } from '../better-auth/identity.service';

@Global()
@Module({
  providers: [CryptoService, PasswordHashService, IdentityService],
  exports: [CryptoService, PasswordHashService, IdentityService],
})
export class CryptoModule {}
