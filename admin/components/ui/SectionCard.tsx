'use client';

import * as React from 'react';
import { Box, Card, CardContent, Divider, Typography } from '@mui/material';

/** Card with a titled section header — settings-page building block. */
export function SectionCard({
  icon,
  title,
  subtitle,
  action,
  disableContentPadding = false,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  /** Optional control on the header's right — an "Upload" button, say. */
  action?: React.ReactNode;
  /** For content that runs to the card's edge, like a table. */
  disableContentPadding?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Box sx={{ px: 2.5, pt: 2, pb: 1.5, display: 'flex', alignItems: 'center', gap: 1.25 }}>
        <Box sx={{ color: 'text.secondary', display: 'flex', '& svg': { fontSize: 20 } }}>
          {icon}
        </Box>
        <Box>
          <Typography variant="subtitle1">{title}</Typography>
          {subtitle && (
            <Typography variant="caption" color="text.secondary">
              {subtitle}
            </Typography>
          )}
        </Box>
        {action && <Box sx={{ ml: 'auto' }}>{action}</Box>}
      </Box>
      <Divider />
      {disableContentPadding ? children : <CardContent sx={{ px: 2.5 }}>{children}</CardContent>}
    </Card>
  );
}
