'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Autocomplete,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { isoDay } from '@/lib/format';
import { CorrectionRequest, Paginated, Site, Worker } from '@/lib/types';

type CorrectionType = 'LOGIN' | 'LOGOUT' | 'MISSING' | 'WRONG_SITE';

const TYPES: { value: CorrectionType; label: string; help: string }[] = [
  { value: 'LOGIN', label: 'Wrong login time', help: 'They were scanned in, at the wrong time.' },
  {
    value: 'LOGOUT',
    label: 'Wrong or missing logout time',
    help: 'They left, but the logout was never scanned or was scanned at the wrong time.',
  },
  {
    value: 'MISSING',
    label: 'Never scanned at all',
    help: 'They worked the day but there is no record of it. This creates the record.',
  },
  {
    value: 'WRONG_SITE',
    label: 'Recorded at the wrong site',
    help: 'The times are right; the day is filed against the wrong site.',
  },
];

const REASONS: { value: string; label: string }[] = [
  { value: 'FORGOT_CARD', label: 'Forgot card' },
  { value: 'DEVICE_ISSUE', label: 'Device issue' },
  { value: 'NETWORK_ISSUE', label: 'Network issue' },
  { value: 'WRONG_SITE', label: 'Wrong site' },
  { value: 'SUPERVISOR_MISTAKE', label: 'Officer mistake' },
  { value: 'OTHER', label: 'Other' },
];

interface Form {
  worker: Worker | null;
  siteId: string;
  type: CorrectionType;
  reason: string;
  date: string;
  loginTime: string;
  logoutTime: string;
  nextDay: boolean;
  correctSiteId: string;
  notes: string;
}

const blank = (): Form => ({
  worker: null,
  siteId: '',
  type: 'LOGOUT',
  reason: 'FORGOT_CARD',
  date: isoDay(new Date()),
  loginTime: '',
  logoutTime: '',
  nextDay: false,
  correctSiteId: '',
  notes: '',
});

/**
 * A local date + "HH:mm" as the instant the officer means.
 *
 * Built from the browser's own zone deliberately: the officer is typing the
 * time they saw on site, so the wall clock in front of them is the right frame.
 * The server stores the instant and derives the work date from it.
 */
function instantOf(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString();
}

/** "YYYY-MM-DD" one day on — where a night shift's out time lands. */
function nextDayOf(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** "06 Aug" — the short day label the overnight tick-box carries. */
function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
  });
}

/**
 * File an attendance correction from the web panel.
 *
 * Mirrors the Safety Officer's mobile form, with one thing the phone does not
 * offer: a wrong-site day can name the site it should have been on.
 *
 * Every time-based correction may carry both ends of the day. A login-only
 * correction that matches no session has to *create* one, and only one open
 * session per worker is allowed — so without a logout it cannot be approved
 * while that worker is clocked in anywhere else.
 *
 * Whether it applies on the spot or waits for an admin is the server's call —
 * it depends on a per-user grant, not on anything this form knows. `onFiled`
 * receives which of the two happened so the caller can say so.
 */
export function NewCorrectionDialog({
  open,
  onClose,
  onFiled,
}: {
  open: boolean;
  onClose: () => void;
  onFiled: (applied: boolean) => void;
}) {
  const [form, setForm] = React.useState<Form>(blank);
  const [search, setSearch] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  React.useEffect(() => {
    if (open) {
      setForm(blank());
      setSearch('');
      setError(null);
    }
  }, [open]);

  const sites = useQuery({
    queryKey: ['sites'],
    queryFn: () => api.get<Site[]>('/sites'),
    enabled: open,
  });

  const workers = useQuery({
    queryKey: ['correction-workers', search],
    queryFn: () => api.get<Paginated<Worker>>(`/workers?q=${encodeURIComponent(search)}&limit=50`),
    enabled: open,
  });

  // One site to choose from is not a choice — pick it so the form is shorter.
  React.useEffect(() => {
    const only = sites.data?.length === 1 ? sites.data[0].id : '';
    if (only) setForm((f) => (f.siteId ? f : { ...f, siteId: only }));
  }, [sites.data]);

  // Which stamp this kind of correction cannot be filed without. Both ends are
  // *offered* for every time-based type — a day that was never scanned needs
  // its logout as much as its login, and one visit to this form should be able
  // to fix a session that is wrong at both ends.
  const needsLogin = form.type === 'LOGIN' || form.type === 'MISSING';
  const needsLogout = form.type === 'LOGOUT';
  const isWrongSite = form.type === 'WRONG_SITE';
  const showsTimes = !isWrongSite;

  // A night shift ends the following morning, so an out time at or before the
  // in time can only mean the next day — tick it for them rather than letting
  // the server refuse it. The box stays there to be unticked when it is a typo.
  const crossesMidnight = !!form.loginTime && !!form.logoutTime && form.logoutTime <= form.loginTime;
  React.useEffect(() => {
    setForm((f) =>
      f.loginTime && f.logoutTime ? { ...f, nextDay: f.logoutTime <= f.loginTime } : f,
    );
  }, [form.loginTime, form.logoutTime]);

  // Only meaningful next to a login time: a logout-only correction carries its
  // own date already (the morning they walked out), which is how the approval
  // finds the session running into it.
  const outDate = form.loginTime && form.nextDay ? nextDayOf(form.date) : form.date;
  const backwards = crossesMidnight && !form.nextDay;

  const file = useMutation({
    mutationFn: () => {
      const items: { field: string; proposedValue: string }[] = [];
      if (showsTimes && form.loginTime) {
        items.push({ field: 'login_at', proposedValue: instantOf(form.date, form.loginTime) });
      }
      if (showsTimes && form.logoutTime) {
        items.push({ field: 'logout_at', proposedValue: instantOf(outDate, form.logoutTime) });
      }
      if (isWrongSite && form.correctSiteId) {
        items.push({ field: 'site_id', proposedValue: form.correctSiteId });
      }
      return api.post<CorrectionRequest>('/corrections', {
        workerId: form.worker!.id,
        siteId: form.siteId,
        // A plain calendar date. Sending a UTC-converted local midnight lands on
        // the previous day at +05:30 and the server's DATE column keeps it there.
        workDate: form.date,
        type: form.type,
        reason: form.reason,
        notes: form.notes.trim() || undefined,
        items,
      });
    },
    onSuccess: (res) => onFiled(res.status === 'APPROVED'),
    onError: (e) => setError(apiErrorMessage(e, 'Could not file this correction')),
  });

  // What each kind of correction cannot be filed without. A "never scanned"
  // entry needs the login — the server can materialise a day from that alone,
  // and will refuse one that proposes nothing to open the session with.
  const enoughToFile = {
    LOGIN: !!form.loginTime,
    LOGOUT: !!form.logoutTime,
    MISSING: !!form.loginTime,
    WRONG_SITE: !!form.correctSiteId && form.correctSiteId !== form.siteId,
  }[form.type];

  const ready = !!form.worker && !!form.siteId && !!form.date && enoughToFile && !backwards;

  const typeHelp = TYPES.find((t) => t.value === form.type)?.help;

  return (
    <Dialog open={open} onClose={file.isPending ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>New correction</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Autocomplete
            options={workers.data?.data ?? []}
            value={form.worker}
            onChange={(_, v) => set('worker', v)}
            onInputChange={(_, v) => setSearch(v)}
            loading={workers.isLoading}
            getOptionLabel={(w) => `${w.workerCode} — ${w.fullName}`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            filterOptions={(x) => x}
            noOptionsText="No match — type a name or code like W-0059"
            renderInput={(params) => (
              <TextField
                {...params}
                label="Who is this about?"
                placeholder="Type a name or worker code"
                required
              />
            )}
          />

          <TextField
            select
            label="Site"
            fullWidth
            required
            value={form.siteId}
            onChange={(e) => set('siteId', e.target.value)}
            helperText={
              isWrongSite ? 'The site the day is wrongly filed against' : 'Where they were working'
            }
          >
            {(sites.data ?? []).map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            label="What is wrong?"
            fullWidth
            value={form.type}
            onChange={(e) => set('type', e.target.value as CorrectionType)}
            helperText={typeHelp}
          >
            {TYPES.map((t) => (
              <MenuItem key={t.value} value={t.value}>
                {t.label}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label={form.loginTime ? 'Day they came in' : 'Day they went out'}
            type="date"
            fullWidth
            required
            InputLabelProps={{ shrink: true }}
            value={form.date}
            onChange={(e) => set('date', e.target.value)}
            helperText={
              // A night shift's logout is the next morning, and the server finds
              // the session from the instant — so the 5th and the 6th are two
              // different corrections.
              !form.loginTime && form.type === 'LOGOUT'
                ? 'For a night shift, this is the morning they walked out.'
                : undefined
            }
          />

          {showsTimes && (
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField
                label={needsLogin ? 'Login time' : 'Login time (optional)'}
                type="time"
                fullWidth
                required={needsLogin}
                InputLabelProps={{ shrink: true }}
                value={form.loginTime}
                onChange={(e) => set('loginTime', e.target.value)}
                helperText={needsLogin ? undefined : 'Leave blank to keep the recorded login.'}
              />
              <TextField
                label={needsLogout ? 'Logout time' : 'Logout time (optional)'}
                type="time"
                fullWidth
                required={needsLogout}
                InputLabelProps={{ shrink: true }}
                value={form.logoutTime}
                onChange={(e) => set('logoutTime', e.target.value)}
                error={backwards}
                helperText={
                  backwards
                    ? 'The logout must be later than the login — tick the box below if they worked through the night.'
                    : form.logoutTime && form.loginTime
                      ? `On ${dayLabel(outDate)}`
                      : form.type === 'MISSING'
                        ? 'Leave blank only if they are still on site now.'
                        : needsLogout
                          ? undefined
                          : 'Leave blank to keep the recorded logout.'
                }
              />
            </Stack>
          )}

          {/* Night shift: in at 9:30 pm, out at 8 am the following morning. */}
          {showsTimes && !!form.loginTime && !!form.logoutTime && (
            <FormControlLabel
              sx={{ mt: -1 }}
              control={
                <Checkbox
                  size="small"
                  checked={form.nextDay}
                  onChange={(e) => set('nextDay', e.target.checked)}
                />
              }
              label={`They went out the next day (${dayLabel(nextDayOf(form.date))})`}
            />
          )}

          {isWrongSite && (
            <TextField
              select
              label="Correct site"
              fullWidth
              required
              value={form.correctSiteId}
              onChange={(e) => set('correctSiteId', e.target.value)}
              helperText="Where the day should be filed instead"
            >
              {(sites.data ?? [])
                .filter((s) => s.id !== form.siteId)
                .map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                  </MenuItem>
                ))}
            </TextField>
          )}

          <TextField
            select
            label="Reason"
            fullWidth
            value={form.reason}
            onChange={(e) => set('reason', e.target.value)}
          >
            {REASONS.map((r) => (
              <MenuItem key={r.value} value={r.value}>
                {r.label}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label="Notes"
            fullWidth
            multiline
            minRows={2}
            value={form.notes}
            onChange={(e) => set('notes', e.target.value)}
            helperText="What happened, in your own words — this is what the audit trail keeps."
          />

          <Typography variant="caption" color="text.secondary">
            Corrections are recorded against your name either way.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose} disabled={file.isPending}>
          Cancel
        </Button>
        <Button variant="contained" disabled={!ready || file.isPending} onClick={() => file.mutate()}>
          {file.isPending ? 'Filing…' : 'File correction'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
