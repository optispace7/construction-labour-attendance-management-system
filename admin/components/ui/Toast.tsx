'use client';

import * as React from 'react';
import { Alert, Snackbar } from '@mui/material';

type Severity = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  message: string;
  severity: Severity;
  key: number;
}

const ToastContext = React.createContext<{
  show: (message: string, severity?: Severity) => void;
  success: (message: string) => void;
  error: (message: string) => void;
} | null>(null);

/** Global toast feedback. Use via `const toast = useToast(); toast.success('Saved')`. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = React.useState<Toast | null>(null);
  const [open, setOpen] = React.useState(false);

  const show = React.useCallback((message: string, severity: Severity = 'info') => {
    setToast({ message, severity, key: Date.now() });
    setOpen(true);
  }, []);

  const value = React.useMemo(
    () => ({
      show,
      success: (m: string) => show(m, 'success'),
      error: (m: string) => show(m, 'error'),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Snackbar
        key={toast?.key}
        open={open}
        // An error is usually a sentence explaining what the server refused and
        // what to do about it — four seconds is not long enough to read one, and
        // it cannot be got back once it has gone.
        autoHideDuration={toast?.severity === 'error' ? 12000 : 4000}
        onClose={(_, reason) => reason !== 'clickaway' && setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.severity ?? 'info'}
          variant="filled"
          onClose={() => setOpen(false)}
          // Capped, or a long sentence stretches to the full width of a desktop
          // screen and reads as one unbroken line.
          sx={{ minWidth: 280, maxWidth: 560, boxShadow: 6 }}
        >
          {toast?.message}
        </Alert>
      </Snackbar>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
