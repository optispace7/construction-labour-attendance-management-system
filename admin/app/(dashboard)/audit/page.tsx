'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Box,
  Button,
  Card,
  Collapse,
  IconButton,
  MenuItem,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import dayjs, { Dayjs } from 'dayjs';
import { api } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge, BadgeTone } from '@/components/ui/StatusBadge';
import { Paginated } from '@/lib/types';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorRole: string | null;
  actorName: string | null;
  entityName: string | null;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  reason: string | null;
  ipAddress: string | null;
  createdAt: string;
}

/** Friendly label + tone per audit action; anything unknown falls back to title-case. */
const ACTIONS: Record<string, { label: string; tone: BadgeTone }> = {
  AUTH_LOGIN: { label: 'Signed in', tone: 'neutral' },
  WORKER_CREATE: { label: 'Person added', tone: 'success' },
  WORKER_UPDATE: { label: 'Person updated', tone: 'info' },
  WORKER_DELETE: { label: 'Person deleted', tone: 'error' },
  WORKER_EXIT: { label: 'Person exited', tone: 'warning' },
  WORKER_REHIRE: { label: 'Person rehired', tone: 'success' },
  WORKER_ASSIGN_SITE: { label: 'Site assigned', tone: 'info' },
  WORKER_CREDENTIAL_BIND: { label: 'Badge / NFC bound', tone: 'info' },
  WORKER_AADHAAR_REVEAL: { label: 'ID number viewed', tone: 'warning' },
  ATTENDANCE_LOGIN: { label: 'Scanned in', tone: 'success' },
  ATTENDANCE_LOGOUT: { label: 'Scanned out', tone: 'neutral' },
  ATTENDANCE_MANUAL_BACKUP: { label: 'Manual attendance entry', tone: 'warning' },
  // A scan the gate confirmed as LOGIN/LOGOUT that arrived after the worker had
  // already gone that way (a double read, or another gate first). Not recorded.
  ATTENDANCE_SCAN_ALREADY_DONE: { label: 'Scan ignored — already done', tone: 'neutral' },
  // Super-admin repairs from the "Fix attendance" page.
  ATTENDANCE_SESSION_EDIT: { label: 'Attendance record corrected', tone: 'warning' },
  ATTENDANCE_SESSION_DELETE: { label: 'Attendance record deleted', tone: 'error' },
  ATTENDANCE_SESSION_BULK_LOGOUT: { label: 'Logged out by admin', tone: 'warning' },
  ATTENDANCE_SESSION_REOPEN: { label: 'Put back on site by admin', tone: 'warning' },
  ATTENDANCE_SESSION_REASSIGN: { label: 'Attendance moved to another person', tone: 'warning' },
  ATTENDANCE_SESSION_CLOSE: { label: 'Logged out by admin', tone: 'warning' },
  CORRECTION_REQUEST: { label: 'Correction requested', tone: 'info' },
  CORRECTION_APPROVE: { label: 'Correction approved', tone: 'success' },
  CORRECTION_REJECT: { label: 'Correction rejected', tone: 'error' },
  CORRECTION_CANCEL: { label: 'Correction cancelled', tone: 'neutral' },
  VENDOR_CREATE: { label: 'Vendor added', tone: 'success' },
  VENDOR_UPDATE: { label: 'Vendor updated', tone: 'info' },
  VENDOR_DEACTIVATE: { label: 'Vendor deactivated', tone: 'warning' },
  VENDOR_DELETE: { label: 'Vendor deleted', tone: 'error' },
  DESIGNATION_CREATE: { label: 'Designation added', tone: 'success' },
  DESIGNATION_UPDATE: { label: 'Designation updated', tone: 'info' },
  DESIGNATION_DEACTIVATE: { label: 'Designation deactivated', tone: 'warning' },
  DESIGNATION_DELETE: { label: 'Designation deleted', tone: 'error' },
  SITE_CREATE: { label: 'Site created', tone: 'success' },
  SITE_UPDATE: { label: 'Site updated', tone: 'info' },
  SITE_SETTINGS_UPDATE: { label: 'Site settings changed', tone: 'info' },
  SHIFT_CREATE: { label: 'Shift created', tone: 'success' },
  SHIFT_UPDATE: { label: 'Shift updated', tone: 'info' },
  USER_CREATE: { label: 'User account created', tone: 'success' },
  USER_UPDATE: { label: 'User account updated', tone: 'info' },
  USER_SCOPES_SET: { label: 'User site access changed', tone: 'info' },
  DEVICE_UPDATE: { label: 'Device updated', tone: 'info' },
  ORG_CREATE: { label: 'Organization created', tone: 'success' },
  ORG_UPDATE: { label: 'Organization updated', tone: 'info' },
};

const ENTITY_TYPES = [
  { value: '', label: 'Everything' },
  { value: 'Worker', label: 'People (workers/staff/visitors)' },
  { value: 'User', label: 'User accounts' },
  { value: 'Site', label: 'Sites' },
  { value: 'CorrectionRequest', label: 'Corrections' },
  { value: 'AttendanceSession', label: 'Attendance records' },
  { value: 'Vendor', label: 'Vendors' },
  { value: 'Designation', label: 'Designations' },
  { value: 'Device', label: 'Devices' },
  { value: 'Shift', label: 'Shifts' },
];

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super Admin',
  SITE_ADMIN: 'Admin',
  SUPERVISOR: 'Safety Officer',
  WATCHMAN: 'Watchman',
};

function actionMeta(action: string) {
  return (
    ACTIONS[action] ?? {
      label: action
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/^./, (c) => c.toUpperCase()),
      tone: 'neutral' as BadgeTone,
    }
  );
}

/** "logoutAt"/"logout_at" → "logout at" */
function niceKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
}

function fmtValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toLocaleString();
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Human one-liner of what actually changed in this event. */
function describe(r: AuditRow): string {
  const o = (r.oldValue ?? {}) as Record<string, unknown>;
  const n = (r.newValue ?? {}) as Record<string, unknown>;
  const parts: string[] = [];

  // Correction payloads carry {type, items:[{field, proposedValue}], reason}.
  const items = n.items;
  if (Array.isArray(items)) {
    if (typeof n.type === 'string') parts.push(`${String(n.type)} correction`);
    for (const it of items as { field?: string; proposedValue?: unknown }[]) {
      if (it?.field) parts.push(`${niceKey(it.field)} → ${fmtValue(it.proposedValue)}`);
    }
  } else {
    const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])];
    for (const k of keys) {
      const before = o[k];
      const after = n[k];
      if (k === 'items' || k === 'reason') continue;
      if (before !== undefined && after !== undefined) {
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          parts.push(`${niceKey(k)}: ${fmtValue(before)} → ${fmtValue(after)}`);
        }
      } else if (after !== undefined) {
        parts.push(`${niceKey(k)}: ${fmtValue(after)}`);
      } else if (before !== undefined) {
        parts.push(`${niceKey(k)} was ${fmtValue(before)}`);
      }
    }
  }

  const reason = r.reason ?? (typeof n.reason === 'string' ? (n.reason as string) : null);
  if (reason) parts.push(`Reason: ${reason}`);

  if (parts.length === 0) {
    if (r.action === 'AUTH_LOGIN') return 'Logged into the system';
    if (r.action === 'WORKER_AADHAAR_REVEAL') return 'Viewed the full (encrypted) ID number';
    return '—';
  }
  return parts.join(' · ');
}

function Row({ r }: { r: AuditRow }) {
  const [open, setOpen] = React.useState(false);
  const meta = actionMeta(r.action);
  const hasRaw = !!(r.oldValue || r.newValue || r.reason || r.ipAddress);
  const target = r.entityName ?? (r.entityId ? `${r.entityType} ${r.entityId.slice(0, 8)}…` : r.entityType);

  return (
    <>
      <TableRow hover onClick={() => hasRaw && setOpen(!open)} sx={hasRaw ? { cursor: 'pointer' } : undefined}>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {new Date(r.createdAt).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {r.actorName ?? '—'}
          {r.actorRole && (
            <Typography variant="caption" color="text.secondary" display="block">
              {ROLE_LABELS[r.actorRole] ?? r.actorRole}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          <StatusBadge label={meta.label} tone={meta.tone} />
        </TableCell>
        <TableCell>{target}</TableCell>
        <TableCell sx={{ maxWidth: 420 }}>
          <Typography variant="body2">{describe(r)}</Typography>
        </TableCell>
        <TableCell padding="checkbox">
          {hasRaw && (
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
              {open ? <KeyboardArrowUpIcon /> : <KeyboardArrowDownIcon />}
            </IconButton>
          )}
        </TableCell>
      </TableRow>
      {hasRaw && (
        <TableRow>
          <TableCell colSpan={6} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ py: 1.5, pl: 1 }}>
                {r.reason && (
                  <Typography variant="body2" gutterBottom>
                    <b>Reason:</b> {r.reason}
                  </Typography>
                )}
                {r.ipAddress && (
                  <Typography variant="body2" gutterBottom>
                    <b>From IP:</b> {r.ipAddress}
                  </Typography>
                )}
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
                  {r.oldValue && (
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        Before
                      </Typography>
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 1.25,
                          bgcolor: 'background.default',
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1.5,
                          fontSize: 12,
                          overflowX: 'auto',
                        }}
                      >
                        {JSON.stringify(r.oldValue, null, 2)}
                      </Box>
                    </Box>
                  )}
                  {r.newValue && (
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography variant="caption" color="text.secondary">
                        After
                      </Typography>
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 1.25,
                          bgcolor: 'background.default',
                          border: '1px solid',
                          borderColor: 'divider',
                          borderRadius: 1.5,
                          fontSize: 12,
                          overflowX: 'auto',
                        }}
                      >
                        {JSON.stringify(r.newValue, null, 2)}
                      </Box>
                    </Box>
                  )}
                </Stack>
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

const COLUMN_COUNT = 6;

export default function AuditPage() {
  const [entityType, setEntityType] = React.useState('');
  const [action, setAction] = React.useState('');
  const [from, setFrom] = React.useState<Dayjs | null>(null);
  const [to, setTo] = React.useState<Dayjs | null>(null);

  const params = new URLSearchParams();
  if (entityType) params.set('entityType', entityType);
  if (action) params.set('action', action);
  if (from) params.set('from', from.startOf('day').toISOString());
  if (to) params.set('to', to.endOf('day').toISOString());
  params.set('limit', '50');
  const baseUrl = `/audit?${params.toString()}`;

  const audit = useQuery({
    queryKey: ['audit', entityType, action, from?.valueOf() ?? null, to?.valueOf() ?? null],
    queryFn: () => api.get<Paginated<AuditRow>>(baseUrl),
  });

  // Cursor pagination: "Load more" appends the next page.
  const [extraRows, setExtraRows] = React.useState<AuditRow[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  React.useEffect(() => {
    setExtraRows([]);
    setNextCursor(audit.data?.nextCursor ?? null);
  }, [audit.data]);
  const rows = [...(audit.data?.data ?? []), ...extraRows];
  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await api.get<Paginated<AuditRow>>(`${baseUrl}&cursor=${nextCursor}`);
      setExtraRows((prev) => [...prev, ...page.data]);
      setNextCursor(page.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <PageHeader title="Audit trail" subtitle="Who did what, when — every change is recorded" />
      <FilterBar>
        <TextField
          select
          size="small"
          label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          sx={{ width: 240 }}
        >
          <MenuItem value="">All actions</MenuItem>
          {Object.entries(ACTIONS).map(([value, m]) => (
            <MenuItem key={value} value={value}>
              {m.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="About"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          sx={{ width: 260 }}
        >
          {ENTITY_TYPES.map((t) => (
            <MenuItem key={t.value} value={t.value}>
              {t.label}
            </MenuItem>
          ))}
        </TextField>
        <DatePicker
          label="From"
          value={from}
          onChange={setFrom}
          slotProps={{ textField: { size: 'small', sx: { width: 170 } } }}
        />
        <DatePicker
          label="To"
          value={to}
          onChange={setTo}
          slotProps={{ textField: { size: 'small', sx: { width: 170 } } }}
        />
        {(action || entityType || from || to) && (
          <Button
            size="small"
            onClick={() => {
              setAction('');
              setEntityType('');
              setFrom(null);
              setTo(null);
            }}
          >
            Clear filters
          </Button>
        )}
      </FilterBar>
      <Card>
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 720 }}>
            <TableHead>
              <TableRow>
                <TableCell>Time</TableCell>
                <TableCell>Who</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>What changed</TableCell>
                <TableCell padding="checkbox" />
              </TableRow>
            </TableHead>
            <TableBody>
              {audit.isLoading &&
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: COLUMN_COUNT }).map((_, j) => (
                      <TableCell key={j} padding={j === COLUMN_COUNT - 1 ? 'checkbox' : undefined}>
                        {j < COLUMN_COUNT - 1 && <Skeleton width={j === 0 ? '70%' : '50%'} />}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!audit.isLoading && rows.map((r) => <Row key={r.id} r={r} />)}
            </TableBody>
          </Table>
        </Box>
        {!audit.isLoading && rows.length === 0 && (
          <EmptyState
            compact
            icon={<HistoryOutlinedIcon />}
            title="No audit records"
            description="Nothing matches these filters — try widening the date range or clearing the filters."
          />
        )}
        {nextCursor && (
          <Stack alignItems="center" sx={{ p: 1.5 }}>
            <Button size="small" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Stack>
        )}
      </Card>
    </LocalizationProvider>
  );
}
