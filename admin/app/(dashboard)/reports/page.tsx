'use client';

import * as React from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Divider,
  FormControlLabel,
  Grid,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import GridOnOutlinedIcon from '@mui/icons-material/GridOnOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { DateTimePicker } from '@mui/x-date-pickers/DateTimePicker';
import dayjs, { Dayjs } from 'dayjs';
import { api, BrowserApiError } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toast';
import { ManpowerReportView, ManpowerReport } from '@/components/ManpowerReportView';
import { Site, Vendor } from '@/lib/types';

const REPORT_TYPES = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'WORKER',
  'VENDOR',
  'SITE',
  'OVERTIME',
  'CORRECTION',
  'ATTENDANCE_SHEET',
];
const REPORT_TYPE_LABELS: Record<string, string> = {
  ATTENDANCE_SHEET: 'Attendance sheet',
};
const PREVIEW_LIMIT = 500;
// Deliberately dull: this survives reloads and should not stand out to anyone
// reading through browser storage.
const CAP_STORAGE_KEY = 'clams.reports.prefs.v1';
/** These run as manpower charts; the rest stay as row previews. */
const CHART_REPORTS = ['DAILY', 'WEEKLY', 'MONTHLY'];

const FORMATS: { value: string; label: string; icon: React.ReactNode }[] = [
  { value: 'CSV', label: 'CSV', icon: <TableChartOutlinedIcon /> },
  { value: 'XLSX', label: 'Excel (XLSX)', icon: <GridOnOutlinedIcon /> },
  { value: 'PDF', label: 'PDF', icon: <PictureAsPdfOutlinedIcon /> },
];

/**
 * An out time that belongs to the following morning. The API sends it as a
 * value rather than decorated text, so the preview can colour it exactly as the
 * Excel and PDF downloads do.
 */
interface NextDayTime {
  value: string;
  day: string;
  nextDay: true;
}
type PreviewCell = string | number | null | NextDayTime;

function isNextDay(v: PreviewCell): v is NextDayTime {
  return typeof v === 'object' && v !== null && (v as NextDayTime).nextDay === true;
}

interface PreviewResult {
  headers: string[];
  rows: PreviewCell[][];
  rowCount: number;
}

interface ReportResult {
  jobId: string;
  status: string;
  content?: string;
  contentBase64?: string;
  contentType?: string;
  filename?: string;
  rowCount?: number;
}

/** The Monday on or before `d`. dayjs weeks start on Sunday, so shift by hand. */
function mondayOf(d: Dayjs): Dayjs {
  return d.subtract((d.day() + 6) % 7, 'day').startOf('day');
}

/** The blue a next-morning out time is written in, here and in the downloads. */
const NEXT_DAY_INK = '#1F5FA8';

/**
 * A preview cell. Timestamps arrive already written out in the site's own
 * timezone ("05 Aug 2026, 09:30 PM"), so the preview shows exactly what the
 * downloaded file will hold — no second conversion against the browser's clock.
 */
function cell(value: PreviewCell): React.ReactNode {
  if (value == null || value === '') return '—';
  if (isNextDay(value)) {
    return (
      <Tooltip arrow title={`Out on ${value.day} — a night shift`}>
        <Box component="span" sx={{ color: NEXT_DAY_INK, fontWeight: 600 }}>
          {value.value}
        </Box>
      </Tooltip>
    );
  }
  return String(value);
}

export default function ReportsPage() {
  const toast = useToast();
  const [reportType, setReportType] = React.useState('MONTHLY');
  const [month, setMonth] = React.useState<Dayjs | null>(dayjs());
  const [date, setDate] = React.useState<Dayjs | null>(dayjs());
  // Weekly report: the admin picks any day, the report covers its Mon–Sun week.
  const [week, setWeek] = React.useState<Dayjs | null>(dayjs());
  const [from, setFrom] = React.useState<Dayjs | null>(dayjs().startOf('month'));
  const [to, setTo] = React.useState<Dayjs | null>(dayjs().endOf('day'));
  const [vendorId, setVendorId] = React.useState('');
  const [siteId, setSiteId] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [sortByVendor, setSortByVendor] = React.useState(false);
  // Full-profile report (adds decrypted Aadhaar/PAN/bank/etc. columns).
  const [includeSensitive, setIncludeSensitive] = React.useState(false);
  // Compliance mode: trim any day over the statutory 9 hours back to 9. There
  // is no control for it on the page — Ctrl+O, S toggles it, and it stays on
  // for every report run from this browser until the same keys turn it off.
  const [capHours, setCapHours] = React.useState(false);
  // Attendance sheet: P/A presence grid vs IN/Out times.
  const [presenceMode, setPresenceMode] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Restored after mount rather than in the initial state, so the server and
  // client first renders match.
  React.useEffect(() => {
    try {
      setCapHours(window.localStorage.getItem(CAP_STORAGE_KEY) === '1');
    } catch {
      /* storage blocked — the cap simply starts off */
    }
  }, []);

  React.useEffect(() => {
    let sawO = false;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      if (key === 'o') {
        sawO = true;
        e.preventDefault();
      } else if (key === 's' && sawO) {
        sawO = false;
        e.preventDefault();
        setCapHours((on) => {
          const next = !on;
          try {
            window.localStorage.setItem(CAP_STORAGE_KEY, next ? '1' : '0');
          } catch {
            /* storage blocked — the cap lasts for this page only */
          }
          return next;
        });
      } else if (key !== 'control') {
        sawO = false;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') sawO = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const vendors = useQuery({ queryKey: ['vendors'], queryFn: () => api.get<Vendor[]>('/vendors') });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const showAttSheet = reportType === 'ATTENDANCE_SHEET';
  const showMonth = reportType === 'MONTHLY';
  const showDate = reportType === 'DAILY';
  const showWeek = reportType === 'WEEKLY';
  const showRange =
    !showMonth && !showDate && !showWeek && !showAttSheet && reportType !== 'CORRECTION';
  const showVendorTools = reportType !== 'CORRECTION';
  // Daily/weekly/monthly render as manpower charts instead of a row table.
  const isChartReport = CHART_REPORTS.includes(reportType);
  // Every report that carries hours honours the cap — the attendance sheet
  // included, where it pulls the day's last Out time back rather than trimming
  // an hours column. Only the correction log is exempt: it is a request log
  // with neither hours nor times to cap.
  const capApplies = capHours && reportType !== 'CORRECTION';

  const buildParams = (): Record<string, unknown> => {
    const params: Record<string, unknown> = {};
    if (showMonth && month) params.month = month.format('YYYY-MM');
    if (showDate && date) params.date = date.format('YYYY-MM-DD');
    if (showWeek && week) params.weekStart = mondayOf(week).format('YYYY-MM-DD');
    if (showRange) {
      if (from) params.from = from.toISOString();
      if (to) params.to = to.toISOString();
    }
    // Attendance sheet: a plain date range (covers a few days or several months).
    if (showAttSheet) {
      if (from) params.from = from.format('YYYY-MM-DD');
      if (to) params.to = to.format('YYYY-MM-DD');
    }
    if (showVendorTools && vendorId) params.vendorId = vendorId;
    if (siteId) params.siteId = siteId;
    if (showVendorTools && category) params.category = category;
    if (showVendorTools && sortByVendor) params.sortBy = 'vendor';
    if (reportType !== 'CORRECTION' && includeSensitive) params.includeSensitive = true;
    if (capApplies) params.capHours = true;
    if (showAttSheet && presenceMode) params.attendanceMode = 'PRESENCE';
    return params;
  };

  const preview = useMutation({
    mutationFn: () =>
      api.post<PreviewResult>('/reports/preview', { reportType, params: buildParams() }),
    onSuccess: () => setError(null),
    onError: (e) => {
      const err = e as BrowserApiError;
      setError(err.body?.detail ?? err.body?.title ?? 'Failed to run report');
    },
  });

  const manpower = useMutation({
    mutationFn: () =>
      api.post<ManpowerReport>('/reports/manpower', { reportType, params: buildParams() }),
    onSuccess: () => setError(null),
    onError: (e) => {
      const err = e as BrowserApiError;
      setError(err.body?.detail ?? err.body?.title ?? 'Failed to run report');
    },
  });

  const run = isChartReport ? manpower : preview;

  const download = useMutation({
    mutationFn: (format: string) =>
      api.post<ReportResult>('/reports', { reportType, format, params: buildParams() }),
    onSuccess: (res, format) => {
      setError(null);
      let blob: Blob | null = null;
      if (res.content) {
        blob = new Blob([res.content], { type: res.contentType ?? 'text/csv' });
      } else if (res.contentBase64) {
        const bytes = Uint8Array.from(atob(res.contentBase64), (c) => c.charCodeAt(0));
        blob = new Blob([bytes], { type: res.contentType ?? 'application/octet-stream' });
      }
      if (!blob) {
        setError('Report generated but no content was returned.');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        res.filename ?? `report-${reportType.toLowerCase()}-${res.jobId}.${format.toLowerCase()}`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`${format} report downloaded`);
    },
    onError: (e) => {
      const err = e as BrowserApiError;
      setError(err.body?.detail ?? err.body?.title ?? 'Failed to generate report');
    },
  });

  const data = preview.data;
  const chart = manpower.data;

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <PageHeader title="Reports" subtitle="Generate attendance, overtime and correction reports" />
      <Card>
        <CardContent>
          {/* 1 — Report type & reporting period */}
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                select
                label="Report type"
                fullWidth
                value={reportType}
                onChange={(e) => {
                  setReportType(e.target.value);
                  preview.reset();
                  manpower.reset();
                }}
              >
                {REPORT_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {REPORT_TYPE_LABELS[t] ?? t}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            {showMonth && (
              <Grid item xs={12} sm={6} md={4}>
                <DatePicker
                  label="Month"
                  views={['year', 'month']}
                  value={month}
                  onChange={setMonth}
                  slotProps={{ textField: { fullWidth: true } }}
                />
              </Grid>
            )}
            {showDate && (
              <Grid item xs={12} sm={6} md={4}>
                <DatePicker
                  label="Date"
                  value={date}
                  onChange={setDate}
                  slotProps={{ textField: { fullWidth: true } }}
                />
              </Grid>
            )}
            {showWeek && (
              <Grid item xs={12} sm={6} md={4}>
                <DatePicker
                  label="Week of"
                  value={week}
                  onChange={setWeek}
                  slotProps={{
                    textField: {
                      fullWidth: true,
                      helperText: week
                        ? `${mondayOf(week).format('DD MMM')} – ${mondayOf(week)
                            .add(6, 'day')
                            .format('DD MMM YYYY')}`
                        : 'Pick any day in the week',
                    },
                  }}
                />
              </Grid>
            )}
            {showRange && (
              <>
                <Grid item xs={12} sm={6} md={4}>
                  <DateTimePicker
                    label="Start date & time"
                    value={from}
                    onChange={setFrom}
                    slotProps={{ textField: { fullWidth: true } }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <DateTimePicker
                    label="End date & time"
                    value={to}
                    onChange={setTo}
                    slotProps={{ textField: { fullWidth: true } }}
                  />
                </Grid>
              </>
            )}
            {showAttSheet && (
              <>
                <Grid item xs={12} sm={6} md={4}>
                  <DatePicker
                    label="From date"
                    value={from}
                    onChange={setFrom}
                    slotProps={{ textField: { fullWidth: true } }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <DatePicker
                    label="To date"
                    value={to}
                    onChange={setTo}
                    slotProps={{ textField: { fullWidth: true } }}
                  />
                </Grid>
              </>
            )}
          </Grid>

          {/* 2 — Filters */}
          <Divider textAlign="left" sx={{ my: 2.5 }}>
            <Typography variant="overline" color="text.secondary">
              Filters
            </Typography>
          </Divider>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={4}>
              <TextField
                select
                label="Site"
                fullWidth
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
              >
                <MenuItem value="">All sites</MenuItem>
                {sites.data?.map((s) => (
                  <MenuItem key={s.id} value={s.id}>
                    {s.name}
                    {s.isActive ? '' : ' (disabled)'}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            {showVendorTools && (
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  select
                  label="Vendor"
                  fullWidth
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                >
                  <MenuItem value="">All vendors</MenuItem>
                  {vendors.data?.map((v) => (
                    <MenuItem key={v.id} value={v.id}>
                      {v.name}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
            )}
            {showVendorTools && (
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  select
                  label="Person type"
                  fullWidth
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <MenuItem value="">All people</MenuItem>
                  <MenuItem value="WORKER">Workers only</MenuItem>
                  <MenuItem value="STAFF">Staff only</MenuItem>
                  <MenuItem value="VISITOR">Visitors only</MenuItem>
                </TextField>
              </Grid>
            )}
          </Grid>

          {/* 3 — Options (only when any apply) */}
          {reportType !== 'CORRECTION' && (
            <>
              <Divider textAlign="left" sx={{ my: 2.5 }}>
                <Typography variant="overline" color="text.secondary">
                  Options
                </Typography>
              </Divider>
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                rowGap={0.5}
                columnGap={3}
                flexWrap="wrap"
              >
                {showVendorTools && (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={sortByVendor}
                        onChange={(e) => setSortByVendor(e.target.checked)}
                      />
                    }
                    label="Sort by vendor"
                  />
                )}
                {showAttSheet && (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={presenceMode}
                        onChange={(e) => setPresenceMode(e.target.checked)}
                      />
                    }
                    label="P/A marking (one column per day)"
                  />
                )}
                <FormControlLabel
                  control={
                    <Switch
                      checked={includeSensitive}
                      onChange={(e) => setIncludeSensitive(e.target.checked)}
                    />
                  }
                  label="Full profile (include sensitive data)"
                />
              </Stack>
            </>
          )}

          {error && (
            <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Stack
            direction="row"
            justifyContent="flex-end"
            alignItems="center"
            spacing={1.5}
            sx={{ mt: 3 }}
          >
            {/* Cap indicator. Filled = the cap will be applied to this report,
                hollow = the cap is on but this report type has no hours to cap.
                Reserves its space either way so nothing shifts when it flips. */}
            <Box
              aria-hidden
              sx={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                opacity: capHours ? 0.5 : 0,
                bgcolor: capApplies ? 'text.disabled' : 'transparent',
                border: capApplies ? 'none' : '1px solid',
                borderColor: 'text.disabled',
              }}
            />
            <Button
              variant="contained"
              size="large"
              startIcon={<PlayArrowIcon />}
              disabled={run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? 'Running…' : 'Run report'}
            </Button>
          </Stack>
        </CardContent>
      </Card>

      {isChartReport && chart && (
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ sm: 'center' }}
              spacing={2}
              sx={{ mb: 2 }}
            >
              <Box>
                <Typography variant="h6">Manpower report — {chart.periodLabel}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {chart.totalManDays} man-day{chart.totalManDays === 1 ? '' : 's'} across{' '}
                  {chart.activeTrades} trade{chart.activeTrades === 1 ? '' : 's'}
                </Typography>
              </Box>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {/* PDF renders these same charts; CSV/XLSX still carry the rows. */}
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<PictureAsPdfOutlinedIcon />}
                  disabled={download.isPending || chart.totalManDays === 0}
                  onClick={() => download.mutate('PDF')}
                >
                  Download charts (PDF)
                </Button>
                {FORMATS.filter((f) => f.value !== 'PDF').map((f) => (
                  <Button
                    key={f.value}
                    variant="outlined"
                    size="small"
                    startIcon={f.icon}
                    disabled={download.isPending || chart.totalManDays === 0}
                    onClick={() => download.mutate(f.value)}
                  >
                    {f.value}
                  </Button>
                ))}
              </Stack>
            </Stack>
            {chart.totalManDays === 0 ? (
              <EmptyState
                compact
                title="No labour attendance"
                description="Nothing matched the selected period and filters — nothing to download."
              />
            ) : (
              <ManpowerReportView data={chart} />
            )}
          </CardContent>
        </Card>
      )}

      {!isChartReport && data && (
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              justifyContent="space-between"
              alignItems={{ sm: 'center' }}
              spacing={2}
              sx={{ mb: 2 }}
            >
              <Typography variant="h6">
                Preview — {data.rowCount} row{data.rowCount === 1 ? '' : 's'}
                {data.rowCount > PREVIEW_LIMIT ? ` (showing first ${PREVIEW_LIMIT})` : ''}
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {FORMATS.map((f) => (
                  <Button
                    key={f.value}
                    variant="contained"
                    size="small"
                    startIcon={f.icon}
                    disabled={download.isPending || data.rowCount === 0}
                    onClick={() => download.mutate(f.value)}
                  >
                    {f.value}
                  </Button>
                ))}
              </Stack>
            </Stack>
            {data.rowCount === 0 ? (
              <EmptyState
                compact
                title="No rows matched"
                description="Nothing matched the selected period and filters — nothing to download."
              />
            ) : (
              <>
                {/* Only worth saying when the period actually holds a night shift. */}
                {data.rows.some((r) => r.some(isNextDay)) && (
                  <Typography
                    variant="caption"
                    display="block"
                    sx={{ mb: 1, color: NEXT_DAY_INK, fontStyle: 'italic' }}
                  >
                    Times are site time, shown under the day the shift started. An out time in
                    blue is on the following morning — a night shift, not a morning entry.
                  </Typography>
                )}
                <Card variant="outlined" sx={{ maxWidth: '100%', overflowX: 'auto' }}>
                  <Table size="small" sx={{ minWidth: 'max-content' }}>
                    <TableHead>
                      <TableRow>
                        {data.headers.map((h) => (
                          <TableCell key={h}>{h}</TableCell>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {data.rows.slice(0, PREVIEW_LIMIT).map((row, i) => (
                        <TableRow key={i} hover>
                          {row.map((v, j) => (
                            <TableCell key={j}>{cell(v)}</TableCell>
                          ))}
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </LocalizationProvider>
  );
}
