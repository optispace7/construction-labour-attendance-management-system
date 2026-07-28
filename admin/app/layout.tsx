import * as React from 'react';
import type { Metadata } from 'next';
import { IBM_Plex_Sans } from 'next/font/google';
import { Providers } from './providers';
import { colorModeScript } from '@/theme/ColorModeProvider';
import './tailwind.css';
import './print.css';

const plex = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CLAMS Admin',
  description: 'Construction Labour Attendance Management System',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the pre-paint script below writes data-theme and
    // an inline background onto <html>, so the client tree legitimately differs
    // from what the server sent. Scoped to this element only.
    <html lang="en" className={plex.variable} suppressHydrationWarning data-theme="dark">
      <head>
        {/* Runs before first paint so a dark-mode user never sees a white
            flash. Must stay ahead of anything that renders. */}
        <script dangerouslySetInnerHTML={{ __html: colorModeScript }} />
      </head>
      <body style={{ margin: 0 }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
