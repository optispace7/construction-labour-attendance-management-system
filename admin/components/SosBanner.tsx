'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertTitle,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
} from '@mui/material';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api/browser';
import { AppNotification } from '@/lib/types';

interface MissedSession {
  sessionId: string;
  workerName: string;
  workerCode: string;
  category: string;
  siteName: string;
  loginAt: string;
}

// Poll fast so an SOS surfaces within a few seconds.
const POLL_MS = 5_000;
const WINDOW_HOURS = 24;

/**
 * Polls the notification feed and shows unacknowledged SOS alerts (last 24h)
 * as a red banner across every admin page. FORGOT_LOGOUT alerts show as a
 * softer warning banner.
 */
export function SosBanner() {
  const qc = useQueryClient();
  const router = useRouter();
  const [detail, setDetail] = React.useState<AppNotification | null>(null);
  const since = React.useMemo(
    () => new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString(),
    [],
  );

  const feed = useQuery({
    queryKey: ['notifications', since],
    queryFn: () => api.get<AppNotification[]>(`/notifications?since=${encodeURIComponent(since)}`),
    refetchInterval: POLL_MS,
    // Keep polling even when the tab is in the background, so an SOS still
    // surfaces promptly when the admin isn't actively looking at the tab.
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const ack = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = (feed.data ?? []).filter((n) => !n.readAt);
  const sos = unread.filter((n) => n.type === 'SOS');
  const forgot = unread.filter((n) => n.type === 'FORGOT_LOGOUT');
  // Only the newest matters: the mailer is either working or it is not, and a
  // six-hourly alarm would otherwise stack up a column of identical banners.
  const mailFailure = unread.filter((n) => n.type === 'EMAIL_FAILING').slice(0, 1);

  // Siren loop while an unacknowledged SOS is on screen; stops on Acknowledge.
  const sosActive = sos.length > 0;
  React.useEffect(() => {
    if (!sosActive) return;
    type AudioCtor = typeof AudioContext;
    const Ctor: AudioCtor | undefined =
      window.AudioContext ?? (window as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    let stopped = false;
    const beep = () => {
      if (stopped) return;
      try {
        void ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.25, ctx.currentTime);
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(620, ctx.currentTime + 0.22);
        osc.frequency.setValueAtTime(880, ctx.currentTime + 0.44);
        osc.start();
        osc.stop(ctx.currentTime + 0.66);
      } catch {
        // Audio blocked until the user interacts with the page — banner still shows.
      }
    };
    beep();
    const interval = setInterval(beep, 1600);
    return () => {
      stopped = true;
      clearInterval(interval);
      void ctx.close();
    };
  }, [sosActive]);

  if (sos.length === 0 && forgot.length === 0 && mailFailure.length === 0) return null;

  return (
    <Stack spacing={1} sx={{ mb: 2 }}>
      {sos.map((n) => (
        <Alert
          key={n.id}
          severity="error"
          variant="filled"
          action={
            <Button color="inherit" size="small" onClick={() => ack.mutate(n.id)}>
              Acknowledge
            </Button>
          }
        >
          <AlertTitle>{n.title}</AlertTitle>
          {n.body.split('\n').map((line, i) =>
            line.startsWith('http') ? (
              <a key={i} href={line} target="_blank" rel="noreferrer" style={{ color: '#fff' }}>
                {line}
              </a>
            ) : (
              <div key={i}>{line}</div>
            ),
          )}
          <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
            {new Date(n.createdAt).toLocaleString()}
          </div>
        </Alert>
      ))}
      {/* Nothing on site is on fire, but every reminder and alert the system
          sends is going nowhere — which is invisible by its nature, since the
          symptom is mail that does not arrive. */}
      {mailFailure.map((n) => (
        <Alert
          key={n.id}
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => ack.mutate(n.id)}>
              Dismiss
            </Button>
          }
        >
          <AlertTitle>{n.title}</AlertTitle>
          {n.body.split('\n\n').map((para, i) => (
            <div key={i} style={{ marginTop: i ? 6 : 0 }}>
              {para}
            </div>
          ))}
        </Alert>
      ))}
      {forgot.slice(0, 3).map((n) => (
        <Alert
          key={n.id}
          severity="warning"
          sx={{ cursor: 'pointer' }}
          onClick={() => setDetail(n)}
          action={
            <Stack direction="row" spacing={1}>
              <Button color="inherit" size="small" onClick={(e) => { e.stopPropagation(); setDetail(n); }}>
                Who?
              </Button>
              <Button color="inherit" size="small" onClick={(e) => { e.stopPropagation(); ack.mutate(n.id); }}>
                Dismiss
              </Button>
            </Stack>
          }
        >
          <AlertTitle>{n.title}</AlertTitle>
          {n.body}
        </Alert>
      ))}

      <Dialog open={detail !== null} onClose={() => setDetail(null)} fullWidth maxWidth="sm">
        <DialogTitle>{detail?.title}</DialogTitle>
        <DialogContent>
          {(() => {
            const sessions = (detail?.data?.sessions as MissedSession[] | undefined) ?? [];
            if (sessions.length === 0) {
              return <div>{detail?.body}</div>;
            }
            return (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Code</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell>Site</TableCell>
                    <TableCell>Logged in at</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sessions.map((s) => (
                    <TableRow key={s.sessionId}>
                      <TableCell>{s.workerName}</TableCell>
                      <TableCell>{s.workerCode}</TableCell>
                      <TableCell>{s.category}</TableCell>
                      <TableCell>{s.siteName}</TableCell>
                      <TableCell>{new Date(s.loginAt).toLocaleString()}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          })()}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => router.push('/attendance?view=missed')}>
            Open attendance page
          </Button>
          {detail && (
            <Button
              onClick={() => {
                ack.mutate(detail.id);
                setDetail(null);
              }}
            >
              Dismiss notification
            </Button>
          )}
          <Button onClick={() => setDetail(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
