import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CompanyDocumentsService } from './company-documents.service';
import { UpdateCompanyDocumentDto, UploadCompanyDocumentDto } from './dto/company-document.dto';
import { RequirePermissions } from '../../common/rbac/rbac.decorators';
import { Permission } from '../../common/rbac/permissions';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { AuthUser } from '../../common/auth/auth-user.interface';

/**
 * Site paperwork — licences, insurance, registrations, each held against the
 * site it covers.
 *
 * Split down the middle: reading is DOCUMENT_VIEW, which the Safety Officer
 * holds, and every change is SETTINGS_MANAGE, which they do not. The class
 * carries the stricter of the two so a route added here without a decorator of
 * its own is closed rather than open — the guard reads the handler first and
 * falls back to the class.
 */
@ApiTags('company-documents')
@ApiBearerAuth()
@Controller('company-documents')
@RequirePermissions(Permission.SETTINGS_MANAGE)
export class CompanyDocumentsController {
  constructor(private readonly documents: CompanyDocumentsService) {}

  @Get()
  @RequirePermissions(Permission.DOCUMENT_VIEW)
  list(@CurrentUser() user: AuthUser, @Query('siteId') siteId?: string) {
    return this.documents.list(user, siteId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: UploadCompanyDocumentDto) {
    return this.documents.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateCompanyDocumentDto,
  ) {
    return this.documents.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documents.remove(user, id);
  }

  /** Streams the PDF itself; the admin panel opens this in a new tab. */
  @Get(':id/file')
  @RequirePermissions(Permission.DOCUMENT_VIEW)
  async file(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const doc = await this.documents.file(user, id);
    res.setHeader('Content-Type', doc.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${sanitiseFilename(doc.fileName)}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(doc.data);
  }
}

/** Keep quotes and control characters out of the Content-Disposition header. */
function sanitiseFilename(name: string): string {
  return name.replace(/[^\w.\-() ]+/g, '_').slice(0, 120) || 'document.pdf';
}
