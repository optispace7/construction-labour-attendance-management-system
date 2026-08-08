'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertTitle,
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  LinearProgress,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import UndoOutlinedIcon from '@mui/icons-material/UndoOutlined';
import CheckCircleOutlineOutlinedIcon from '@mui/icons-material/CheckCircleOutlineOutlined';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { DataTable, Column } from '@/components/ui/DataTable';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useToast } from '@/components/ui/Toast';
import { Paginated, Site, Worker } from '@/lib/types';

interface FixSession {
  id: string;
  workerId: string;
  siteId: string;
  workDate: string;
  loginAt: string;
  logoutAt: string | null;
  state: 'OPEN' | 'CLOSED' | 'AUTO_CLOSED';
  workedMinutes: number | null;
  overtimeMinutes: number | null;
  closedReason: string | null;
  loginTapId: string | null;
  logoutTapId: string | null;
  isDuplicate: boolean;
  worker: {
    id: string;
    fullName: string;
    workerCode: string;
    category?: string;
    designation?: { name: string } | null;
    vendor?: { name: string } | null;
  };
  site?: { id: string; name: string; timezone: string } | null;
}

interface DayResponse {
  date: string;
  timezone: string;
  sessions: FixSession[];
  openCount: number;
}

interface BulkPreview {
  dryRun: boolean;
  date: string;
  time: string;
  closed: {
    id: string;
    workerCode: string;
    fullName: string;
    loginAt: string;
    logoutAt: string;
    workedMinutes: number;
    overtimeMinutes: number;
  }[];
  skipped: { id: string; workerCode: string; fullName: string; reason: string }[];
}

interface ReopenPreview {
  dryRun: boolean;
  reopened: {
    id: string;
    workerCode: string;
    fullName: string;
    loginAt: string;
    wasLogoutAt: string | null;
    wasWorkedMinutes: number | null;
  }[];
  skipped: { id: string; workerCode: string; fullName: string; reason: string }[];
}

/** Today as YYYY-MM-DD in the browser's own timezone. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** "06:05 PM" — the time alone; the date is the page's date filter. */
function clock(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** ISO instant → "HH:mm" for a <input type="time">, in browser-local time. */
function toTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "YYYY-MM-DD" + "HH:mm" read as local wall-clock → ISO instant. */
function fromTimeInput(date: string, hhmm: string): string {
  return new Date(`${date}T${hhmm}:00`).toISOString();
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

/** "7h 35m" */
function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000);
}

/** Before → after, the shape every dialog uses to show what will change. */
function Change({ before, after }: { before: React.ReactNode; after: React.ReactNode }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
      <Typography variant="body2" sx={{ textDecoration: 'line-through', color: 'text.disabled' }}>
        {before}
      </Typography>
      <ArrowForwardIcon fontSize="small" sx={{ color: 'text.disabled' }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {after}
      </Typography>
    </Stack>
  );
}

/** Shared reason field — required on every repair, and it lands in the audit log. */
function ReasonField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <TextField
      label="Why are you changing this?"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      helperText="Saved in the audit log with your name, so anyone can see later why the record changed."
      fullWidth
      required
      multiline
      minRows={2}
    />
  );
}

// ---------------------------------------------------------------- dialogs

function ReassignDialog({
  session,
  onClose,
  onDone,
}: {
  session: FixSession | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [worker, setWorker] = React.useState<Worker | null>(null);
  const [reason, setReason] = React.useState('');
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    if (session) {
      setWorker(null);
      setReason('');
      setSearch('');
    }
  }, [session]);

  const workers = useQuery({
    queryKey: ['fix-workers', search],
    queryFn: () =>
      api.get<Paginated<Worker>>(`/workers?q=${encodeURIComponent(search)}&limit=50`),
    enabled: !!session,
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/attendance/admin/sessions/${session!.id}`, {
        workerId: worker!.id,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(`Session moved to ${worker!.workerCode} ${worker!.fullName}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not move this session')),
  });

  const ready = !!worker && reason.trim().length >= 3;

  return (
    <Dialog open={!!session} onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Wrong person on this record</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          The times stay exactly as they are — only the name on the record changes. Use this when
          one person&apos;s card was scanned for somebody else.
        </Typography>

        <Card variant="outlined" sx={{ mb: 2.5, bgcolor: 'action.hover' }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="caption" color="text.secondary">
              This record
            </Typography>
            <Typography variant="body2" sx={{ mt: 0.25 }}>
              In {clock(session?.loginAt ?? null)} · Out {clock(session?.logoutAt ?? null)}
              {session?.state === 'OPEN' && ' (still on site)'}
            </Typography>
          </CardContent>
        </Card>

        <Stack spacing={2.5}>
          <Autocomplete
            options={workers.data?.data ?? []}
            value={worker}
            onChange={(_, v) => setWorker(v)}
            onInputChange={(_, v) => setSearch(v)}
            loading={workers.isLoading}
            getOptionLabel={(w) => `${w.workerCode} — ${w.fullName}`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            filterOptions={(x) => x}
            noOptionsText="No match — type a name or code like W-0059"
            renderInput={(params) => (
              <TextField
                {...params}
                label="Who was actually on site?"
                placeholder="Type a name or worker code"
                required
                helperText="Search by worker code (W-0059) or by name"
              />
            )}
          />

          {worker && session && (
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                What will change
              </Typography>
              <Change
                before={`${session.worker.workerCode} ${session.worker.fullName}`}
                after={`${worker.workerCode} ${worker.fullName}`}
              />
            </Box>
          )}

          <ReasonField
            value={reason}
            onChange={setReason}
            placeholder="e.g. W-0034 did not come to site today; W-0059 worked this shift"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={save.isPending} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => save.mutate()}
          disabled={!ready || save.isPending}
          variant="contained"
        >
          {save.isPending ? 'Moving…' : 'Move this record'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function TimesDialog({
  session,
  date,
  onClose,
  onDone,
}: {
  session: FixSession | null;
  date: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [loginTime, setLoginTime] = React.useState('');
  const [logoutTime, setLogoutTime] = React.useState('');
  const [nextDay, setNextDay] = React.useState(false);
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (session) {
      setLoginTime(toTimeInput(session.loginAt));
      setLogoutTime(session.logoutAt ? toTimeInput(session.logoutAt) : '');
      setReason('');
    }
  }, [session]);

  // A night shift ends on the following morning, so an out time earlier than the
  // in time can only mean the next day — tick it for them rather than refusing
  // the edit. The box stays there to be untucked when the time really is a typo.
  React.useEffect(() => {
    if (loginTime && logoutTime) setNextDay(logoutTime <= loginTime);
  }, [loginTime, logoutTime]);

  const outDate = nextDay ? nextDayOf(date) : date;
  const loginIso = loginTime ? fromTimeInput(date, loginTime) : null;
  const logoutIso = logoutTime ? fromTimeInput(outDate, logoutTime) : null;
  const mins = loginIso && logoutIso ? minutesBetween(loginIso, logoutIso) : null;
  const backwards = mins !== null && mins <= 0;
  // Not refused — a 16-hour day is legal, if unusual — but worth a second look,
  // because it is also what a mistyped hour looks like once "next day" is on.
  const overlong = mins !== null && mins > 16 * 60;

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/attendance/admin/sessions/${session!.id}`, {
        loginAt: loginIso,
        logoutAt: logoutIso,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(`Times updated for ${session!.worker.fullName}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not update the times')),
  });

  const ready = !!loginTime && !backwards && reason.trim().length >= 3;

  return (
    <Dialog open={!!session} onClose={save.isPending ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Change in and out times</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          {session?.worker.workerCode} · {session?.worker.fullName} · {date}
        </Typography>

        <Stack spacing={2.5}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              label="Came in at"
              type="time"
              value={loginTime}
              onChange={(e) => setLoginTime(e.target.value)}
              InputLabelProps={{ shrink: true }}
              fullWidth
              required
            />
            <TextField
              label="Went out at"
              type="time"
              value={logoutTime}
              onChange={(e) => setLogoutTime(e.target.value)}
              InputLabelProps={{ shrink: true }}
              fullWidth
              error={backwards}
              helperText={
                backwards
                  ? 'The out time must be later than the in time — tick the box below if they worked through the night'
                  : logoutTime
                    ? `On ${dayLabel(outDate)}`
                    : 'Leave empty to put this person back on site'
              }
            />
          </Stack>

          {/* Night shift: in at 9:30 pm, out at 8 am the following morning. */}
          {!!logoutTime && (
            <FormControlLabel
              sx={{ mt: -1 }}
              control={
                <Checkbox
                  size="small"
                  checked={nextDay}
                  onChange={(e) => setNextDay(e.target.checked)}
                />
              }
              label={`They went out the next day (${dayLabel(nextDayOf(date))})`}
            />
          )}

          {overlong && (
            <Alert severity="warning">
              That is {duration(mins!)} on site. Check the times and the next-day box before
              saving.
            </Alert>
          )}

          {mins !== null && !backwards && session && (
            <Box>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
                Hours on site
              </Typography>
              <Change
                before={
                  session.workedMinutes !== null ? duration(session.workedMinutes) : 'still on site'
                }
                after={duration(mins)}
              />
            </Box>
          )}

          <ReasonField
            value={reason}
            onChange={setReason}
            placeholder="e.g. Everyone left at 6:05 pm but the gate scanner was not used"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={save.isPending} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => save.mutate()}
          disabled={!ready || save.isPending}
          variant="contained"
        >
          {save.isPending ? 'Saving…' : 'Save times'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DeleteDialog({
  session,
  onClose,
  onDone,
}: {
  session: FixSession | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (session) setReason('');
  }, [session]);

  const remove = useMutation({
    mutationFn: () =>
      api.del(`/attendance/admin/sessions/${session!.id}`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(`Removed ${session!.worker.fullName} from ${session!.workDate.slice(0, 10)}`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not delete this record')),
  });

  return (
    <Dialog
      open={!!session}
      onClose={remove.isPending ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>Delete this attendance record?</DialogTitle>
      <DialogContent>
        <Alert severity="warning" sx={{ mb: 2.5 }}>
          This removes the whole day&apos;s attendance for this person. They will be counted absent
          and their hours will not appear in reports or payroll.
        </Alert>

        <Card variant="outlined" sx={{ mb: 2.5, bgcolor: 'action.hover' }}>
          <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {session?.worker.workerCode} · {session?.worker.fullName}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
              In {clock(session?.loginAt ?? null)} · Out {clock(session?.logoutAt ?? null)}
              {session?.workedMinutes !== null && session?.workedMinutes !== undefined
                ? ` · ${duration(session.workedMinutes)}`
                : ''}
            </Typography>
          </CardContent>
        </Card>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          The original scan is kept in the audit trail — only this attendance record goes away.
        </Typography>

        <ReasonField
          value={reason}
          onChange={setReason}
          placeholder="e.g. Duplicate record created by a second scan after logout"
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={remove.isPending} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => remove.mutate()}
          disabled={reason.trim().length < 3 || remove.isPending}
          variant="contained"
          color="error"
        >
          {remove.isPending ? 'Deleting…' : 'Delete record'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function BulkLogoutDialog({
  open,
  preview,
  time,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  preview: BulkPreview | null;
  time: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const closed = preview?.closed ?? [];
  const skipped = preview?.skipped ?? [];

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Log out {closed.length} {closed.length === 1 ? 'person' : 'people'} at {time}?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Check the list before confirming. Nothing has been saved yet.
        </Typography>

        <Card variant="outlined" sx={{ mb: skipped.length ? 2 : 0 }}>
          <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
            {closed.map((c, i) => (
              <Box key={c.id}>
                {i > 0 && <Divider />}
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={2}
                  sx={{ px: 2, py: 1.25 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {c.fullName}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {c.workerCode} · in {clock(c.loginAt)}
                    </Typography>
                  </Box>
                  <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
                    {duration(c.workedMinutes)}
                  </Typography>
                </Stack>
              </Box>
            ))}
          </Box>
        </Card>

        {skipped.length > 0 && (
          <Alert severity="info">
            <AlertTitle>
              {skipped.length} {skipped.length === 1 ? 'person is' : 'people are'} not included
            </AlertTitle>
            {skipped.map((s) => (
              <Typography key={s.id} variant="body2">
                {s.workerCode} {s.fullName} — {s.reason.toLowerCase()}
              </Typography>
            ))}
            <Typography variant="body2" sx={{ mt: 1 }}>
              Fix these one at a time from the table below.
            </Typography>
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          disabled={busy || closed.length === 0}
          variant="contained"
          startIcon={<LogoutOutlinedIcon />}
        >
          {busy ? 'Logging out…' : `Log out ${closed.length}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Undo a logout — the mirror of the sweep, and just as common: a second stray
 * tap scans someone out a minute after they arrived while they are still
 * working. Takes one row or a whole selection, and previews itself through a
 * dryRun before writing, so the operator sees who really goes back on site.
 */
function ReopenDialog({
  sessions,
  onClose,
  onDone,
}: {
  sessions: FixSession[] | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = React.useState('');
  const [preview, setPreview] = React.useState<ReopenPreview | null>(null);
  const open = !!sessions && sessions.length > 0;

  React.useEffect(() => {
    if (open) {
      setReason('');
      setPreview(null);
    }
  }, [open, sessions]);

  const body = (dryRun: boolean) => ({
    sessionIds: (sessions ?? []).map((s) => s.id),
    reason: reason.trim(),
    dryRun,
  });

  const check = useMutation({
    mutationFn: () => api.post<ReopenPreview>('/attendance/admin/bulk-reopen', body(true)),
    onSuccess: setPreview,
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not check these records')),
  });

  const apply = useMutation({
    mutationFn: () => api.post<ReopenPreview>('/attendance/admin/bulk-reopen', body(false)),
    onSuccess: (data) => {
      const n = data.reopened.length;
      toast.success(`Put ${n} ${n === 1 ? 'person' : 'people'} back on site`);
      onDone();
      onClose();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not put them back on site')),
  });

  const busy = check.isPending || apply.isPending;
  const chosen = sessions ?? [];
  const going = preview?.reopened ?? [];
  const skipped = preview?.skipped ?? [];

  // Before the check the rows come from the table; after it, from the server's
  // verdict. One shape either way, so the list renders the same both times.
  const listed = preview
    ? going.map((r) => ({
        id: r.id,
        code: r.workerCode,
        name: r.fullName,
        loginAt: r.loginAt,
        out: r.wasLogoutAt,
      }))
    : chosen.map((s) => ({
        id: s.id,
        code: s.worker.workerCode,
        name: s.worker.fullName,
        loginAt: s.loginAt,
        out: s.logoutAt,
      }));

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {preview
          ? `Put ${going.length} ${going.length === 1 ? 'person' : 'people'} back on site?`
          : `Undo the logout for ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}`}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {preview
            ? 'Check the list before confirming. Nothing has been saved yet.'
            : 'Their out time is removed and they go back to being shown as on site. Their hours for the day are cleared until they are scanned out again.'}
        </Typography>

        <Card variant="outlined" sx={{ mb: 2.5 }}>
          <Box sx={{ maxHeight: 260, overflowY: 'auto' }}>
            {listed.map((row, i) => (
              <Box key={row.id}>
                {i > 0 && <Divider />}
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={2}
                  sx={{ px: 2, py: 1.25 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: 500 }}>
                      {row.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {row.code} · in {clock(row.loginAt)}
                    </Typography>
                  </Box>
                  <Change before={`out ${clock(row.out)}`} after="on site" />
                </Stack>
              </Box>
            ))}
          </Box>
        </Card>

        {skipped.length > 0 && (
          <Alert severity="info" sx={{ mb: 2.5 }}>
            <AlertTitle>
              {skipped.length} {skipped.length === 1 ? 'person is' : 'people are'} not included
            </AlertTitle>
            {skipped.map((s) => (
              <Typography key={s.id} variant="body2">
                {s.workerCode} {s.fullName} — {s.reason.toLowerCase()}
              </Typography>
            ))}
          </Alert>
        )}

        {!preview && (
          <ReasonField
            value={reason}
            onChange={setReason}
            placeholder="e.g. Scanned out by mistake on a second tap; they were still working"
          />
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} color="inherit">
          Cancel
        </Button>
        {preview ? (
          <Button
            onClick={() => apply.mutate()}
            disabled={busy || going.length === 0}
            variant="contained"
            startIcon={<UndoOutlinedIcon />}
          >
            {apply.isPending ? 'Saving…' : `Put ${going.length} back on site`}
          </Button>
        ) : (
          <Button
            onClick={() => check.mutate()}
            disabled={busy || reason.trim().length < 3}
            variant="contained"
          >
            {check.isPending ? 'Checking…' : 'Review'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------- page

export default function FixAttendancePage() {
  const toast = useToast();
  const qc = useQueryClient();

  const [date, setDate] = React.useState(todayLocal());
  const [siteId, setSiteId] = React.useState('all');
  const [logoutTime, setLogoutTime] = React.useState('18:00');
  const [bulkNextDay, setBulkNextDay] = React.useState(false);
  const [bulkReason, setBulkReason] = React.useState('');
  const [preview, setPreview] = React.useState<BulkPreview | null>(null);

  const [reassign, setReassign] = React.useState<FixSession | null>(null);
  const [retime, setRetime] = React.useState<FixSession | null>(null);
  const [remove, setRemove] = React.useState<FixSession | null>(null);
  const [reopen, setReopen] = React.useState<FixSession[] | null>(null);
  const [menu, setMenu] = React.useState<{ el: HTMLElement; row: FixSession } | null>(null);
  const [picked, setPicked] = React.useState<string[]>([]);

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const dayKey = ['fix-day', date, siteId];
  const day = useQuery({
    queryKey: dayKey,
    queryFn: () =>
      api.get<DayResponse>(
        `/attendance/admin/day?date=${date}${siteId !== 'all' ? `&siteId=${siteId}` : ''}`,
      ),
  });

  const refresh = () => {
    setPicked([]);
    return qc.invalidateQueries({ queryKey: ['fix-day'] });
  };

  // A tick on one day's table means nothing on the next, so the selection is
  // dropped whenever the operator changes what they are looking at.
  React.useEffect(() => setPicked([]), [date, siteId]);

  // With rows ticked the sweep narrows to those; with none it takes everyone
  // still open, which is what the card offers by default.
  const bulkBody = (dryRun: boolean) => ({
    date,
    time: logoutTime,
    siteId: siteId === 'all' ? undefined : siteId,
    sessionIds: picked.length ? picked : undefined,
    nextDay: bulkNextDay,
    reason: bulkReason.trim(),
    dryRun,
  });

  const previewBulk = useMutation({
    mutationFn: () => api.post<BulkPreview>('/attendance/admin/bulk-logout', bulkBody(true)),
    onSuccess: (data) => setPreview(data),
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not work out who is still on site')),
  });

  const applyBulk = useMutation({
    mutationFn: () => api.post<BulkPreview>('/attendance/admin/bulk-logout', bulkBody(false)),
    onSuccess: (data) => {
      toast.success(
        `Logged out ${data.closed.length} ${data.closed.length === 1 ? 'person' : 'people'} at ${data.time}`,
      );
      setPreview(null);
      setBulkReason('');
      refresh();
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not log everyone out')),
  });

  const sessions = day.data?.sessions ?? [];
  const openCount = day.data?.openCount ?? 0;
  const stillOn = sessions.filter((s) => s.state === 'OPEN');
  const duplicates = sessions.filter((s) => s.isDuplicate);
  const bulkReady = /^([01]\d|2[0-3]):([0-5]\d)$/.test(logoutTime) && bulkReason.trim().length >= 3;

  const chosen = sessions.filter((s) => picked.includes(s.id));
  const chosenClosed = chosen.filter((s) => s.state !== 'OPEN');
  const chosenOpen = chosen.filter((s) => s.state === 'OPEN');
  const allPicked = sessions.length > 0 && picked.length === sessions.length;

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const columns: Column<FixSession>[] = [
    {
      key: 'pick',
      label: (
        <Checkbox
          size="small"
          checked={allPicked}
          indeterminate={picked.length > 0 && !allPicked}
          onChange={() => setPicked(allPicked ? [] : sessions.map((s) => s.id))}
          inputProps={{ 'aria-label': 'Select every record on this day' }}
          sx={{ ml: -1.25 }}
        />
      ),
      width: 52,
      render: (s) => (
        <Checkbox
          size="small"
          checked={picked.includes(s.id)}
          onChange={() => toggle(s.id)}
          inputProps={{ 'aria-label': `Select ${s.worker.fullName}` }}
          sx={{ ml: -1.25 }}
        />
      ),
    },
    {
      key: 'worker',
      label: 'Person',
      render: (s) => (
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {s.worker.fullName}
            </Typography>
            {s.isDuplicate && (
              <Tooltip title="This person has more than one record on this day — usually a double scan">
                <Chip
                  size="small"
                  color="warning"
                  variant="outlined"
                  icon={<ContentCopyOutlinedIcon />}
                  label="Duplicate"
                />
              </Tooltip>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary">
            {s.worker.workerCode}
            {s.worker.designation?.name ? ` · ${s.worker.designation.name}` : ''}
          </Typography>
        </Box>
      ),
    },
    { key: 'vendor', label: 'Vendor', render: (s) => s.worker.vendor?.name ?? '—' },
    ...(siteId === 'all'
      ? [
          {
            key: 'site',
            label: 'Site',
            render: (s: FixSession) => s.site?.name ?? '—',
          } as Column<FixSession>,
        ]
      : []),
    {
      key: 'in',
      label: 'Came in',
      render: (s) => (
        <Typography variant="body2" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {clock(s.loginAt)}
        </Typography>
      ),
    },
    {
      key: 'out',
      label: 'Went out',
      render: (s) => (
        <Typography
          variant="body2"
          sx={{
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            color: s.logoutAt ? undefined : 'warning.main',
            fontWeight: s.logoutAt ? 400 : 600,
          }}
        >
          {s.logoutAt
            ? // A night shift's out time belongs to the next morning; without the
              // day beside it "08:00" reads as an in time typed the wrong way round.
              new Date(s.logoutAt).toDateString() !== new Date(s.loginAt).toDateString()
              ? `${clock(s.logoutAt)} · ${new Date(s.logoutAt).toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: 'short',
                })}`
              : clock(s.logoutAt)
            : 'Still on site'}
        </Typography>
      ),
    },
    {
      key: 'worked',
      label: 'Hours',
      render: (s) => (
        <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {s.workedMinutes !== null ? duration(s.workedMinutes) : '—'}
        </Typography>
      ),
    },
    {
      key: 'state',
      label: 'Status',
      render: (s) =>
        s.state === 'OPEN' ? (
          <StatusBadge label="On site" tone="warning" />
        ) : (
          <StatusBadge label="Logged out" tone="success" />
        ),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      width: 56,
      render: (s) => (
        <Tooltip title="Fix this record">
          <IconButton
            size="small"
            aria-label={`Fix the record for ${s.worker.fullName}`}
            onClick={(e) => setMenu({ el: e.currentTarget, row: s })}
          >
            <MoreVertIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Fix attendance"
        subtitle="Correct a wrong name, change in and out times, undo a logout, remove a record, or log out everyone still on site"
        action={
          <Button
            variant="outlined"
            startIcon={<RefreshOutlinedIcon />}
            onClick={refresh}
            disabled={day.isFetching}
          >
            Refresh
          </Button>
        }
      />

      <Alert severity="info" sx={{ mb: 3 }}>
        Every change here is saved straight away and recorded in <strong>Audit</strong> with your
        name and your reason. There is no undo, so check the details in the confirmation box before
        you save.
      </Alert>

      <FilterBar>
        <TextField
          label="Day"
          type="date"
          size="small"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
          sx={{ width: 190 }}
        />
        <TextField
          select
          size="small"
          label="Site"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          sx={{ width: 240 }}
        >
          <MenuItem value="all">All sites</MenuItem>
          {sites.data?.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </TextField>
      </FilterBar>

      {day.isFetching && <LinearProgress sx={{ mb: 2 }} />}

      {/* End-of-day sweep — the common repair, so it leads the page. */}
      {openCount > 0 ? (
        <Card
          sx={{
            mb: 3,
            borderLeft: 4,
            borderColor: 'warning.main',
          }}
        >
          <CardContent>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
              <LogoutOutlinedIcon fontSize="small" color="warning" />
              <Typography variant="subtitle1">
                {openCount} {openCount === 1 ? 'person is' : 'people are'} still shown as on site
              </Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Nobody scanned them out. Set the time they actually left and log them all out
              together.
            </Typography>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2.5 }}>
              {stillOn.map((s) => (
                <Chip
                  key={s.id}
                  size="small"
                  variant="outlined"
                  label={`${s.worker.workerCode} ${s.worker.fullName} · in ${clock(s.loginAt)}`}
                />
              ))}
            </Stack>

            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
              <Box sx={{ width: { xs: '100%', md: 190 }, flexShrink: 0 }}>
                <TextField
                  label="They left at"
                  type="time"
                  value={logoutTime}
                  onChange={(e) => setLogoutTime(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                  helperText={`Site time (${day.data?.timezone ?? 'Asia/Kolkata'})`}
                  fullWidth
                />
                {/* Night shift: everyone still open started the evening before. */}
                <FormControlLabel
                  sx={{ mt: 0.5 }}
                  control={
                    <Checkbox
                      size="small"
                      checked={bulkNextDay}
                      onChange={(e) => setBulkNextDay(e.target.checked)}
                    />
                  }
                  label={
                    <Typography variant="body2">
                      Next morning ({dayLabel(nextDayOf(date))})
                    </Typography>
                  }
                />
              </Box>
              <TextField
                label="Why are you logging them out?"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                placeholder="e.g. Shift ended at 6:05 pm, gate scanner was not used"
                helperText="Saved in the audit log with your name"
                fullWidth
                required
              />
              <Button
                variant="contained"
                color="warning"
                size="large"
                startIcon={<LogoutOutlinedIcon />}
                disabled={!bulkReady || previewBulk.isPending}
                onClick={() => previewBulk.mutate()}
                sx={{ flexShrink: 0, mt: { md: 1 } }}
              >
                {previewBulk.isPending
                  ? 'Checking…'
                  : chosenOpen.length > 0
                    ? `Review and log out (${chosenOpen.length} selected)`
                    : 'Review and log out'}
              </Button>
            </Stack>
          </CardContent>
        </Card>
      ) : (
        !day.isLoading &&
        sessions.length > 0 && (
          <Alert icon={<CheckCircleOutlineOutlinedIcon />} severity="success" sx={{ mb: 3 }}>
            Everyone on this day is logged out. Nothing left to sweep.
          </Alert>
        )
      )}

      {duplicates.length > 0 && (
        <Alert severity="warning" sx={{ mb: 3 }}>
          <AlertTitle>
            {duplicates.length} {duplicates.length === 1 ? 'record looks' : 'records look'} like a
            double scan
          </AlertTitle>
          Some people have more than one record on this day. Check the rows marked{' '}
          <strong>Duplicate</strong> below and delete the one that should not be there.
        </Alert>
      )}

      <Typography variant="subtitle1" sx={{ mb: 0.25 }}>
        Everyone recorded on {date} ({sessions.length})
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
        Tick people to fix several at once, or use the menu at the end of a row for one person
      </Typography>

      {/* Ticked rows: the batch repairs that need no times typed in. */}
      {picked.length > 0 && (
        <Card sx={{ mb: 1.5, borderLeft: 4, borderColor: 'primary.main' }}>
          <CardContent
            sx={{
              py: 1.5,
              '&:last-child': { pb: 1.5 },
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1.5,
              alignItems: 'center',
            }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600, mr: 'auto' }}>
              {picked.length} selected
              {chosenOpen.length > 0 && chosenClosed.length > 0
                ? ` · ${chosenClosed.length} logged out, ${chosenOpen.length} on site`
                : ''}
            </Typography>
            <Button size="small" color="inherit" onClick={() => setPicked([])}>
              Clear
            </Button>
            <Tooltip
              title={
                chosenClosed.length === 0
                  ? 'Everyone selected is already shown as on site'
                  : 'Remove their out time and show them as on site again'
              }
            >
              <span>
                <Button
                  variant="contained"
                  startIcon={<UndoOutlinedIcon />}
                  disabled={chosenClosed.length === 0}
                  onClick={() => setReopen(chosenClosed)}
                >
                  Put back on site ({chosenClosed.length})
                </Button>
              </span>
            </Tooltip>
          </CardContent>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={sessions}
        loading={day.isLoading}
        rowKey={(s) => s.id}
        emptyTitle="No attendance on this day"
        emptyDescription="Nobody was scanned in on the selected day and site."
      />

      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setReassign(menu!.row);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <SwapHorizOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText
            primary="This is the wrong person"
            secondary="Move the record to somebody else"
          />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setRetime(menu!.row);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <ScheduleOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Change the times" secondary="Fix when they came in or went out" />
        </MenuItem>
        {menu?.row.state !== 'OPEN' && (
          <MenuItem
            onClick={() => {
              setReopen([menu!.row]);
              setMenu(null);
            }}
          >
            <ListItemIcon>
              <UndoOutlinedIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText
              primary="Undo the logout"
              secondary="They never left — put them back on site"
            />
          </MenuItem>
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            setRemove(menu!.row);
            setMenu(null);
          }}
        >
          <ListItemIcon>
            <DeleteOutlineOutlinedIcon fontSize="small" color="error" />
          </ListItemIcon>
          <ListItemText
            primary="Delete this record"
            secondary="They were not on site at all"
            primaryTypographyProps={{ color: 'error.main' }}
          />
        </MenuItem>
      </Menu>

      <ReassignDialog session={reassign} onClose={() => setReassign(null)} onDone={refresh} />
      <TimesDialog session={retime} date={date} onClose={() => setRetime(null)} onDone={refresh} />
      <DeleteDialog session={remove} onClose={() => setRemove(null)} onDone={refresh} />
      <ReopenDialog sessions={reopen} onClose={() => setReopen(null)} onDone={refresh} />
      <BulkLogoutDialog
        open={!!preview}
        preview={preview}
        time={bulkNextDay ? `${logoutTime} on ${dayLabel(nextDayOf(date))}` : logoutTime}
        busy={applyBulk.isPending}
        onConfirm={() => applyBulk.mutate()}
        onClose={() => setPreview(null)}
      />
    </>
  );
}
