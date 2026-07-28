'use client';

import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import EmotionRegistry from '@/theme/EmotionRegistry';
import { ColorModeProvider } from '@/theme/ColorModeProvider';
import { ToastProvider } from '@/components/ui/Toast';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );

  return (
    <EmotionRegistry>
      {/* ColorModeProvider owns ThemeProvider + CssBaseline: the theme object
          it supplies depends on the mode it holds, so the two cannot be split. */}
      <ColorModeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>{children}</ToastProvider>
        </QueryClientProvider>
      </ColorModeProvider>
    </EmotionRegistry>
  );
}
