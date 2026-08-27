'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { formatNumber } from '@/lib/format';
import { useTokens } from '@/components/dash/charts';

export interface DrawerMetric {
  metric: string;
  label: string;
  group: string;
  /** The figure for the period the board is showing, for context in the header. */
  periodValue: number;
}

interface HistoryRow {
  date: string;
  value: number | null;
  comment: string | null;
  recorded: boolean;
  /**
   * What the day's figure is made of, for the metrics that are a total of
   * something rather than a number somebody typed. Null for the rest.
   */
  breakdown: { label: string; value: number }[] | null;
}
interface HistoryResult {
  metric: string;
  label: string;
  rows: HistoryRow[];
}

const dayLabel = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00.000Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

/**
 * One metric, day by day.
 *
 * A drawer rather than a modal: the board stays visible beside it, so clicking
 * through several stats in a row reads as inspecting one page instead of opening
 * and closing dialogs. Read-only by design — this is the reporting view, and the
 * daily task sheet is where figures get changed.
 *
 * The trend is the date picker. Thirty bars, click one, everything below follows
 * — which is faster than a calendar for the question actually being asked ("when
 * did that spike?") and is why there is no date field in here.
 */
export function MetricDetailDrawer({
  metric,
  siteId,
  anchorDate,
  onClose,
}: {
  metric: DrawerMetric | null;
  siteId: string;
  /** The board's selected date — where the drawer opens. */
  anchorDate: string;
  onClose: () => void;
}) {
  const t = useTokens();
  const [selected, setSelected] = React.useState(anchorDate);

  // A different stat, or a different day on the board, re-anchors the drawer.
  React.useEffect(() => {
    if (metric) setSelected(anchorDate);
  }, [metric, anchorDate]);

  const history = useQuery({
    queryKey: ['safety-history', metric?.metric, siteId, anchorDate],
    queryFn: () => {
      // A month back from the board's date, so the window always contains it.
      const to = anchorDate;
      const from = new Date(new Date(`${anchorDate}T00:00:00.000Z`).getTime() - 29 * 86400000)
        .toISOString()
        .slice(0, 10);
      return api.get<HistoryResult>(
        `/safety/history?metric=${metric!.metric}&siteId=${siteId}&from=${from}&to=${to}`,
      );
    },
    enabled: Boolean(metric),
  });

  // Memoised so the `?? []` fallback does not hand a fresh array to the log's
  // useMemo on every render.
  const rows = React.useMemo(() => history.data?.rows ?? [], [history.data]);
  /**
   * Fall back to the newest day when the anchor is not in the window.
   *
   * Without this the drawer shows a dash, and — because both arrows disable on
   * a missing index — offers no way out of it. The two normally agree, but a
   * timezone edge should not strand the reader on an empty panel.
   */
  const found = rows.findIndex((r) => r.date === selected);
  const index = found >= 0 ? found : rows.length - 1;
  const current = index >= 0 ? rows[index] : null;
  const peak = Math.max(1, ...rows.map((r) => r.value ?? 0));

  const step = (delta: number) => {
    if (index < 0) return;
    const next = rows[index + delta];
    if (next) setSelected(next.date);
  };

  // Newest first reads better in a log; the trend below stays chronological.
  const logRows = React.useMemo(() => [...rows].reverse().filter((r) => r.recorded), [rows]);

  return (
    <Drawer
      anchor="right"
      open={Boolean(metric)}
      onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', sm: 430 }, backgroundImage: 'none' } }}
    >
      {metric && (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          {/* ---- Header ---- */}
          <Stack direction="row" alignItems="flex-start" sx={{ px: 2.5, pt: 2.5, pb: 2, gap: 1 }}>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography variant="h6" sx={{ lineHeight: 1.25 }}>
                {metric.label}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {metric.group} · {formatNumber(metric.periodValue)} in the selected period
              </Typography>
            </Box>
            <IconButton size="small" onClick={onClose} aria-label="Close">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          <Divider />

          {history.isLoading ? (
            <Box sx={{ display: 'grid', placeItems: 'center', flex: 1 }}>
              <CircularProgress size={26} />
            </Box>
          ) : history.isError ? (
            <Box sx={{ p: 2.5 }}>
              <Alert severity="error">
                {apiErrorMessage(history.error, 'Could not load this metric.')}
              </Alert>
            </Box>
          ) : (
            <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              {/* ---- Day stepper + figure ---- */}
              <Box sx={{ px: 2.5, pt: 2.5, pb: 1 }}>
                <Stack direction="row" alignItems="center" justifyContent="space-between">
                  <Tooltip title="Previous day">
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => step(-1)}
                        disabled={index <= 0}
                        aria-label="Previous day"
                      >
                        <ChevronLeftIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {dayLabel(selected)}
                  </Typography>
                  <Tooltip title="Next day">
                    <span>
                      <IconButton
                        size="small"
                        onClick={() => step(1)}
                        disabled={index < 0 || index >= rows.length - 1}
                        aria-label="Next day"
                      >
                        <ChevronRightIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Stack>

                <Box sx={{ textAlign: 'center', py: 2 }}>
                  <Typography
                    sx={{
                      fontSize: 44,
                      fontWeight: 700,
                      lineHeight: 1,
                      color: current?.recorded ? 'text.primary' : 'text.disabled',
                    }}
                  >
                    {current?.value == null ? '—' : formatNumber(current.value)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {/* A blank is a blank, not a zero — the officer never said zero. */}
                    {current?.recorded ? 'recorded' : 'not filled in'}
                  </Typography>
                </Box>
              </Box>

              {/* ---- The trend doubles as the date picker ---- */}
              <Box sx={{ px: 2.5, pb: 2 }}>
                <Stack
                  direction="row"
                  alignItems="flex-end"
                  spacing={0.4}
                  sx={{ height: 68, mb: 0.75 }}
                >
                  {rows.map((r) => {
                    const isSel = r.date === selected;
                    const h = r.value ? Math.max(4, (r.value / peak) * 62) : 3;
                    return (
                      <Tooltip
                        key={r.date}
                        title={`${shortDay(r.date)} · ${r.value == null ? 'not filled in' : formatNumber(r.value)}`}
                        sx={{ flex: 1 }}
                      >
                        <Box
                          role="button"
                          tabIndex={0}
                          aria-label={`${shortDay(r.date)}, ${r.value ?? 'not filled in'}`}
                          onClick={() => setSelected(r.date)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSelected(r.date);
                            }
                          }}
                          sx={{
                            flex: 1,
                            minWidth: 4,
                            height: h,
                            borderRadius: 0.75,
                            cursor: 'pointer',
                            bgcolor: isSel
                              ? t.brand
                              : r.recorded
                                ? 'action.disabled'
                                : 'action.disabledBackground',
                            transition: 'background-color 140ms ease, height 200ms ease',
                            '&:hover': { bgcolor: isSel ? t.brand : 'text.secondary' },
                          }}
                        />
                      </Tooltip>
                    );
                  })}
                </Stack>
                <Stack direction="row" justifyContent="space-between">
                  <Typography variant="caption" color="text.disabled">
                    {rows.length ? shortDay(rows[0].date) : ''}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    Tap a bar to jump to that day
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    {rows.length ? shortDay(rows[rows.length - 1].date) : ''}
                  </Typography>
                </Stack>
              </Box>

              <Divider />

              {/* ---- Comment for the selected day ---- */}
              <Box sx={{ px: 2.5, py: 2 }}>
                <Typography
                  variant="caption"
                  sx={{
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    color: 'text.disabled',
                  }}
                >
                  COMMENT
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    mt: 0.75,
                    color: current?.comment ? 'text.primary' : 'text.disabled',
                    fontStyle: current?.comment ? 'normal' : 'italic',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {current?.comment ?? 'No comment on this day.'}
                </Typography>
              </Box>

              <Divider />

              {/* ---- The log ---- */}
              <Box sx={{ px: 2.5, py: 2 }}>
                <Typography
                  variant="caption"
                  sx={{ fontWeight: 700, letterSpacing: '0.08em', color: 'text.disabled' }}
                >
                  HISTORY · LAST 30 DAYS
                </Typography>
                {logRows.length === 0 ? (
                  <Typography variant="body2" color="text.disabled" sx={{ mt: 1 }}>
                    Nothing recorded in this window.
                  </Typography>
                ) : (
                  <Stack sx={{ mt: 1 }} divider={<Divider flexItem />}>
                    {logRows.map((r) => (
                      <Box
                        key={r.date}
                        onClick={() => setSelected(r.date)}
                        sx={{
                          py: 1,
                          cursor: 'pointer',
                          borderRadius: 1,
                          bgcolor: r.date === selected ? 'action.selected' : 'transparent',
                          '&:hover': { bgcolor: 'action.hover' },
                        }}
                      >
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          <Typography variant="body2" sx={{ width: 58, flexShrink: 0 }}>
                            {shortDay(r.date)}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{
                              width: 46,
                              flexShrink: 0,
                              textAlign: 'right',
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                            }}
                          >
                            {r.value == null ? '—' : formatNumber(r.value)}
                          </Typography>
                          <Typography
                            variant="body2"
                            color="text.secondary"
                            noWrap
                            title={r.comment ?? undefined}
                            sx={{ minWidth: 0, flex: 1 }}
                          >
                            {r.comment ?? '—'}
                          </Typography>
                        </Stack>

                        {/* What that day's total was made of, revealed by
                            clicking the row it belongs to. Only the open row
                            shows it: thirty days of splits at once is a wall,
                            and the question being asked is about one day. */}
                        {r.date === selected && r.breakdown && r.breakdown.length > 0 && (
                          <Stack sx={{ pl: '70px', pr: 1, pt: 0.5, rowGap: 0.25 }}>
                            {r.breakdown.map((b) => (
                              <Stack
                                key={b.label}
                                direction="row"
                                spacing={1}
                                alignItems="baseline"
                              >
                                <Typography
                                  variant="caption"
                                  color="text.disabled"
                                  noWrap
                                  title={b.label}
                                  sx={{ minWidth: 0, flex: 1 }}
                                >
                                  {b.label}
                                </Typography>
                                <Typography
                                  variant="caption"
                                  sx={{
                                    fontWeight: 700,
                                    color: 'text.secondary',
                                    fontVariantNumeric: 'tabular-nums',
                                  }}
                                >
                                  {formatNumber(b.value)}
                                </Typography>
                              </Stack>
                            ))}
                          </Stack>
                        )}
                      </Box>
                    ))}
                  </Stack>
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Drawer>
  );
}
