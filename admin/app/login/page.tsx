'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { LoginGlass } from '@/components/LoginGlass';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

interface FormValues {
  identifier: string;
  password: string;
}

type Mode = 'login' | 'forgot' | 'otp' | 'done';

/**
 * The reset token, from whatever the person actually has to hand.
 *
 * Opening the emailed link puts it in the query string. Some mail clients
 * mangle a link badly enough that people copy the whole URL and paste it
 * instead, so a pasted URL is accepted as well as a bare token — the
 * alternative is telling somebody their link is invalid when it is not.
 */
function extractToken(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  try {
    return new URL(value).searchParams.get('token');
  } catch {
    return value;
  }
}

/** The problem+json shape the API returns, as much of it as this page reads. */
interface ApiErrorBody {
  detail?: string;
  title?: string;
  code?: string;
  deviceStatus?: string;
  // The forgot-password flow answers on the same reader.
  emailSent?: boolean;
  message?: string;
  // Handed back by OTP verification and passed straight to the reset call.
  resetToken?: string;
}

export default function LoginPage() {
  const router = useRouter();
  const { register, handleSubmit } = useForm<FormValues>();
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>('login');

  // Forgot-password state
  const [fpIdentifier, setFpIdentifier] = React.useState('');
  const [resetToken, setResetToken] = React.useState<string | null>(null);
  const [otp, setOtp] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');

  // Arriving from a reset link: go straight to setting a new password rather
  // than showing a sign-in form the person cannot yet use.
  React.useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) return;
    setResetToken(token);
    setMode('otp');
    setInfo('Choose a new password.');
    // Take the token out of the address bar: it is a credential until it is
    // used, and it would otherwise sit in history and in any screenshot.
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setInfo(null);
  }

  async function onSubmit(values: FormValues) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values),
      });
      if (!res.ok) {
        const body = ((await res.json().catch(() => ({}))) as ApiErrorBody) as ApiErrorBody;
        // Only 401 means the credentials were wrong. Everything else — the API
        // unreachable, a route missing, a 500 — used to be reported as
        // "Invalid credentials" too, which sent people to reset a password
        // that was never the problem. Say what actually happened instead.
        const detail = body?.detail ?? body?.title;
        setError(
          detail ??
            (res.status === 401
              ? 'Invalid credentials'
              : `Could not reach the server (error ${res.status}). Please try again, or tell your administrator if it continues.`),
        );
        return;
      }
      router.replace('/');
      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  async function requestOtp() {
    if (!fpIdentifier.trim()) {
      setError('Enter your email or user ID first.');
      return;
    }
    setLoading(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: fpIdentifier.trim() }),
      });
      const body = ((await res.json().catch(() => ({}))) as ApiErrorBody) as ApiErrorBody;
      if (!res.ok) {
        setError(body?.detail ?? body?.title ?? 'Could not start password reset');
        return;
      }
      if (body.emailSent) {
        setInfo(body.message ?? null);
        setMode('otp');
      } else {
        // Watchman / no email on file → point them at their admin.
        setError(body.message ?? null);
      }
    } finally {
      setLoading(false);
    }
  }

  async function submitReset() {
    // The code is gone: Better Auth emails a link, and the token that used to
    // be six digits typed by hand now arrives in the URL. The field is kept
    // for the case where somebody pastes the whole link rather than opening it.
    const token = resetToken ?? extractToken(otp);
    if (!token) {
      setError('Open the link from your email, or paste it here.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const reset = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, newPassword }),
      });
      if (!reset.ok) {
        const rBody = (await reset.json().catch(() => ({}))) as ApiErrorBody;
        setError(rBody?.detail ?? rBody?.title ?? 'Could not reset password');
        return;
      }
      switchMode('done');
    } finally {
      setLoading(false);
    }
  }

  return (
    // The glass panel replaces the plain card. Everything inside — the four
    // modes, the auth calls, the error handling — is untouched; only the
    // container changed.
    <LoginGlass>
      <Box>
          <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
            <Box sx={{ bgcolor: '#0F365D', borderRadius: 2, px: 3, py: 1.5, display: 'inline-flex' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/logo.png"
                alt="Optispace"
                style={{ height: 48, maxWidth: 220, objectFit: 'contain', display: 'block' }}
              />
            </Box>
          </Box>

          {mode === 'login' && (
            <>
              <Typography variant="h5" gutterBottom>
                CLAMS Admin
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Sign in to manage attendance
              </Typography>
              <form onSubmit={handleSubmit(onSubmit)}>
                <Stack spacing={2}>
                  {error && <Alert severity="error">{error}</Alert>}
                  <TextField label="Email or user ID" fullWidth {...register('identifier')} />
                  <TextField label="Password" type="password" fullWidth {...register('password')} />
                  <Button type="submit" variant="contained" size="large" disabled={loading}>
                    {loading ? 'Signing in…' : 'Sign in'}
                  </Button>
                  <Link
                    component="button"
                    type="button"
                    variant="body2"
                    onClick={() => switchMode('forgot')}
                    sx={{ alignSelf: 'center' }}
                  >
                    Forgot password?
                  </Link>
                </Stack>
              </form>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <Typography variant="h6" gutterBottom>
                Reset password
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Enter your email (or user ID) and we&apos;ll send a 6-digit code to your email.
                Watchman accounts are reset by an Admin.
              </Typography>
              <Stack spacing={2}>
                {error && <Alert severity="warning">{error}</Alert>}
                <TextField
                  label="Email or user ID"
                  fullWidth
                  value={fpIdentifier}
                  onChange={(e) => setFpIdentifier(e.target.value)}
                />
                <Button variant="contained" size="large" onClick={requestOtp} disabled={loading}>
                  {loading ? 'Sending…' : 'Send code'}
                </Button>
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={() => switchMode('login')}
                  sx={{ alignSelf: 'center' }}
                >
                  Back to sign in
                </Link>
              </Stack>
            </>
          )}

          {mode === 'otp' && (
            <>
              <Typography variant="h6" gutterBottom>
                Set a new password
              </Typography>
              <Stack spacing={2}>
                {info && <Alert severity="success">{info}</Alert>}
                {error && <Alert severity="error">{error}</Alert>}
                {/* Hidden once the link has been opened, because the token is
                    already in hand and asking for it again only invites
                    somebody to paste the wrong thing. */}
                {!resetToken && (
                  <TextField
                    label="Paste the link from your email"
                    fullWidth
                    value={otp}
                    // No digits-only filter here any more: what goes in is a
                    // URL now, and stripping everything but numbers turned a
                    // valid link into nonsense.
                    onChange={(e) => setOtp(e.target.value)}
                  />
                )}
                <TextField
                  label="New password"
                  type="password"
                  fullWidth
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <TextField
                  label="Confirm new password"
                  type="password"
                  fullWidth
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <Button variant="contained" size="large" onClick={submitReset} disabled={loading}>
                  {loading ? 'Resetting…' : 'Set new password'}
                </Button>
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={requestOtp}
                  sx={{ alignSelf: 'center' }}
                >
                  Resend code
                </Link>
              </Stack>
            </>
          )}

          {mode === 'done' && (
            <>
              <Typography variant="h6" gutterBottom>
                Password updated
              </Typography>
              <Stack spacing={2}>
                <Alert severity="success">
                  Your password has been changed. Sign in with the new password.
                </Alert>
                <Button variant="contained" size="large" onClick={() => switchMode('login')}>
                  Back to sign in
                </Button>
              </Stack>
            </>
          )}
      </Box>
    </LoginGlass>
  );
}
