import { Module } from '@nestjs/common';
import { CompanyDocumentsController } from './company-documents.controller';
import { CompanyDocumentsService } from './company-documents.service';
import { DocumentExpiryMonitor } from './document-expiry.monitor';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [CompanyDocumentsController],
  providers: [CompanyDocumentsService, DocumentExpiryMonitor],
})
export class CompanyDocumentsModule {}
