import { Global, Module } from '@nestjs/common';
import { CryptoService } from './crypto.service';
import { PasswordHashService } from './password-hash.service';

@Global()
@Module({
  providers: [CryptoService, PasswordHashService],
  exports: [CryptoService, PasswordHashService],
})
export class CryptoModule {}
