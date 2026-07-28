'use client';

import * as React from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined';
import { useColorMode } from '@/theme/ColorModeProvider';

/**
 * Sun/moon switch for the app header.
 *
 * The two icons are stacked and cross-faded rather than swapped, so the change
 * reads as one object turning over instead of a flicker. Rotation is small and
 * fast — this is a preference control, not a feature to show off.
 *
 * Renders a fixed-size placeholder until the provider has read localStorage, so
 * the header does not reflow when the real icon arrives.
 */
export function ThemeToggle({ size = 'small' }: { size?: 'small' | 'medium' }) {
  const { mode, toggle } = useColorMode();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const box = size === 'small' ? 34 : 40;
  const icon = size === 'small' ? 18 : 20;

  if (!mounted) return <Box sx={{ width: box, height: box }} aria-hidden />;

  const isDark = mode === 'dark';

  return (
    <Tooltip title={isDark ? 'Switch to light mode' : 'Switch to dark mode'} arrow>
      <IconButton
        onClick={toggle}
        aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        sx={{
          width: box,
          height: box,
          color: 'text.secondary',
          borderRadius: 2,
          '&:hover': { color: 'text.primary', bgcolor: 'action.hover' },
        }}
      >
        <Box sx={{ position: 'relative', width: icon, height: icon }}>
          {[
            { Icon: DarkModeOutlinedIcon, show: isDark },
            { Icon: LightModeOutlinedIcon, show: !isDark },
          ].map(({ Icon, show }, i) => (
            <Icon
              key={i}
              sx={{
                position: 'absolute',
                inset: 0,
                fontSize: icon,
                opacity: show ? 1 : 0,
                transform: show ? 'rotate(0deg) scale(1)' : 'rotate(-45deg) scale(0.75)',
                transition: 'opacity 180ms ease, transform 220ms cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
          ))}
        </Box>
      </IconButton>
    </Tooltip>
  );
}
