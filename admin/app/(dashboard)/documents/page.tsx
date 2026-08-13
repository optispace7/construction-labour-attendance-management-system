'use client';

import * as React from 'react';
import { Stack } from '@mui/material';
import { PageHeader } from '@/components/PageHeader';
import { CompanyDocuments } from '@/components/CompanyDocuments';

/**
 * Site paperwork, on a page of its own.
 *
 * These started out on the Company page, next to the name and logo, which put
 * them under "details printed on an ID card" — but a licence belongs to a
 * project and has a date that matters, so it earns its own place in the
 * sidebar rather than living at the bottom of a settings form.
 */
export default function DocumentsPage() {
  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Licences, insurance and registrations — held against the site they cover"
      />
      <Stack spacing={2.5} sx={{ maxWidth: 1100 }}>
        <CompanyDocuments />
      </Stack>
    </>
  );
}
