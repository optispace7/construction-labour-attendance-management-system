'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Script from 'next/script';
import { Manrope } from 'next/font/google';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  LinearProgress,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import AccessTimeOutlinedIcon from '@mui/icons-material/AccessTimeOutlined';
import AddLocationAltOutlinedIcon from '@mui/icons-material/AddLocationAltOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ConstructionOutlinedIcon from '@mui/icons-material/ConstructionOutlined';
import EngineeringOutlinedIcon from '@mui/icons-material/EngineeringOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import PersonAddAltOutlinedIcon from '@mui/icons-material/PersonAddAltOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import ReportProblemOutlinedIcon from '@mui/icons-material/ReportProblemOutlined';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { api, apiErrorMessage } from '@/lib/api/browser';
import type { VendorTrendData } from '@/components/VendorTrendTooltip';
import { CorrectionRequest, Paginated, Site } from '@/lib/types';

const dashboardFont = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

interface StatPerson {
  fullName: string;
  workerCode: string;
  siteName: string | null;
  loginAt: string;
}

interface StatBucket {
  count: number;
  people: StatPerson[];
}

interface DashboardStats {
  onSiteNow: { total: number; byCategory: Record<string, StatBucket> };
  missedLogout: { date: string; total: number; byCategory: Record<string, StatBucket> };
}

interface Manpower {
  days: string[];
  trend: number[];
  from: string;
  to: string;
  totalManDays: number;
  totalToday: number;
  manHoursToday: number;
  activeTrades: number;
  byTrade: { trade: string; count: number }[];
  byVendor: { vendor: string; count: number }[];
}

interface DashboardCharts {
  vendorTrend: VendorTrendData;
  manpower: Manpower;
  siteWise: { site: string; onSite: number }[];
  distribution: { category: string; onSite: number }[];
  correctionsBySite: { site: string; pending: number }[];
  vendorToday: { vendor: string; count: number }[];
}

interface AuditRow {
  id: string;
  action: string;
  actorName: string | null;
  entityName: string | null;
  createdAt: string;
}

const ink = '#17211D';
const line = '#D8D5CC';
const teal = '#176C64';
const amber = '#E4A82F';
const rust = '#B34C32';
const blue = '#3B6484';
const violet = '#735C86';
const vendorColors = [
  '#E44545',
  '#F0A51A',
  '#3F5FCC',
  '#16A39A',
  '#D95D9B',
  '#6C52A3',
  '#67A53A',
  '#2F7FAD',
];
const activityLabels: Record<string, string> = {
  AUTH_LOGIN: 'signed in',
  WORKER_CREATE: 'added a worker',
  WORKER_UPDATE: 'updated a profile',
  WORKER_ASSIGN_SITE: 'changed a site assignment',
  CORRECTION_REQUEST: 'requested a correction',
  CORRECTION_APPROVE: 'approved a correction',
  CORRECTION_REJECT: 'rejected a correction',
  SITE_CREATE: 'opened a site',
  SITE_UPDATE: 'updated a site',
  DEVICE_UPDATE: 'updated a device',
  USER_CREATE: 'created a user',
  USER_UPDATE: 'updated a user',
  USER_DELETE: 'deleted a user',
  AUTH_PASSWORD_RESET: 'reset a password',
};

function isoDay(date: Date) {
  const p = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

function shiftDays(value: string, delta: number) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + delta);
  return isoDay(date);
}

function defaultRange() {
  const today = isoDay(new Date());
  return { from: shiftDays(today, -6), to: today };
}

function formatDay(value: string, includeYear = false) {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: includeYear ? 'numeric' : undefined,
  });
}

function number(value?: number | null) {
  if (value == null) return '—';
  return new Intl.NumberFormat().format(value);
}

const panelSx = {
  bgcolor: 'rgba(255, 255, 255, 0.72)',
  backdropFilter: 'blur(18px) saturate(1.16)',
  WebkitBackdropFilter: 'blur(18px) saturate(1.16)',
  border: `1px solid ${alpha('#FFFFFF', 0.72)}`,
  boxShadow: `0 12px 34px ${alpha('#20372F', 0.08)}, inset 0 1px 0 ${alpha('#FFFFFF', 0.9)}, inset 0 0 0 1px ${alpha('#7D958B', 0.12)}`,
  borderRadius: '6px',
  minWidth: 0,
};

function SectionHeading({
  index,
  title,
  subtitle,
  action,
}: {
  index: string;
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        minHeight: 69,
        px: { xs: 2, md: 2.5 },
        py: 1.5,
        borderBottom: `1px solid ${line}`,
        display: 'flex',
        flexDirection: { xs: 'column', sm: 'row' },
        alignItems: { xs: 'stretch', sm: 'center' },
        justifyContent: 'space-between',
        gap: 2,
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="center" minWidth={0}>
        <Typography
          aria-hidden="true"
          sx={{
            fontFamily: 'monospace',
            color: teal,
            fontSize: 11,
            fontWeight: 800,
            flexShrink: 0,
          }}
        >
          {index}
        </Typography>
        <Box minWidth={0}>
          <Typography sx={{ fontSize: 15, fontWeight: 750, color: ink, lineHeight: 1.2 }}>
            {title}
          </Typography>
          <Typography sx={{ mt: 0.35, fontSize: 11.5, color: '#69726D' }}>{subtitle}</Typography>
        </Box>
      </Stack>
      {action && <Box sx={{ flexShrink: 0 }}>{action}</Box>}
    </Box>
  );
}

function QueryState({
  loading,
  error,
  empty,
  emptyText,
  height = 260,
  onRetry,
  children,
}: {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyText: string;
  height?: number;
  onRetry?: () => void;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Box sx={{ p: 2.5, height }}>
        <Skeleton variant="rounded" height="100%" sx={{ borderRadius: 1 }} />
      </Box>
    );
  }
  if (error) {
    return (
      <Stack sx={{ height, px: 3 }} alignItems="center" justifyContent="center" spacing={1.5}>
        <ReportProblemOutlinedIcon sx={{ color: rust }} />
        <Typography variant="body2" textAlign="center" color="text.secondary">
          {error}
        </Typography>
        {onRetry && (
          <Button size="small" startIcon={<RefreshOutlinedIcon />} onClick={onRetry}>
            Retry
          </Button>
        )}
      </Stack>
    );
  }
  if (empty) {
    return (
      <Stack sx={{ height, px: 3 }} alignItems="center" justifyContent="center" spacing={1}>
        <Box sx={{ width: 30, height: 2, bgcolor: amber }} />
        <Typography variant="body2" color="text.secondary">
          {emptyText}
        </Typography>
      </Stack>
    );
  }
  return <>{children}</>;
}

type HoverDetail = { primary: string; secondary?: string };

function MetricHoverCard({
  title,
  items,
  emptyText,
}: {
  title: string;
  items: HoverDetail[];
  emptyText: string;
}) {
  const shown = items.slice(0, 8);
  return (
    <Box sx={{ minWidth: 250, maxWidth: 350, py: 0.5 }}>
      <Typography sx={{ fontSize: 12, fontWeight: 800, color: '#FFFFFF' }}>{title}</Typography>
      <Divider sx={{ my: 0.8, borderColor: alpha('#FFFFFF', 0.2) }} />
      {shown.length === 0 ? (
        <Typography sx={{ fontSize: 11.5, color: alpha('#FFFFFF', 0.72) }}>{emptyText}</Typography>
      ) : (
        <Stack spacing={0.85}>
          {shown.map((item, index) => (
            <Box key={`${item.primary}-${index}`}>
              <Typography sx={{ fontSize: 11.5, lineHeight: 1.35, fontWeight: 700, color: '#FFFFFF' }}>
                {item.primary}
              </Typography>
              {item.secondary && (
                <Typography sx={{ mt: 0.15, fontSize: 10.5, lineHeight: 1.35, color: alpha('#FFFFFF', 0.65) }}>
                  {item.secondary}
                </Typography>
              )}
            </Box>
          ))}
        </Stack>
      )}
      {items.length > shown.length && (
        <Typography sx={{ mt: 0.9, fontSize: 10.5, fontWeight: 700, color: '#F4C430' }}>
          +{items.length - shown.length} more
        </Typography>
      )}
    </Box>
  );
}

function StatusMetric({
  label,
  value,
  note,
  icon,
  color,
  loading,
  onClick,
  tooltip,
  glassReady,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  icon: React.ReactNode;
  color: string;
  loading?: boolean;
  onClick: () => void;
  tooltip: React.ReactNode;
  glassReady: boolean;
}) {
  const glassRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (!glassReady || !glassRef.current) return;
    const liquidGlass = (window as typeof window & {
      liquidGlass?: (
        element: HTMLElement,
        options: Record<string, number>,
      ) => { destroy: () => void };
    }).liquidGlass;
    if (!liquidGlass) return;
    const instance = liquidGlass(glassRef.current, {
      scale: -54,
      chroma: 2,
      border: 0.12,
      mapBlur: 10,
      blur: 5,
      saturate: 1.2,
      fallbackBlur: 14,
      radius: 6,
    });
    return () => instance.destroy();
  }, [glassReady]);

  return (
    <Tooltip
      title={tooltip}
      placement="bottom-start"
      arrow
      enterDelay={250}
      slotProps={{
        tooltip: { sx: { maxWidth: 380, p: 1.25, bgcolor: '#202B38' } },
        arrow: { sx: { color: '#202B38' } },
      }}
    >
      <Box
        ref={glassRef}
        component="button"
        type="button"
        onClick={onClick}
        sx={{
          appearance: 'none',
          position: 'relative',
          minWidth: 0,
          minHeight: 118,
          p: 0,
          border: 0,
          bgcolor: 'rgba(255, 255, 255, 0.54)',
          color: ink,
          textAlign: 'left',
          cursor: 'pointer',
          overflow: 'hidden',
          boxShadow: `inset 0 1px 0 ${alpha('#FFFFFF', 0.96)}, inset 0 -12px 24px ${alpha('#FFFFFF', 0.12)}`,
          transition: 'background-color 160ms ease, box-shadow 180ms ease, transform 180ms ease',
          '&::before': {
            content: '""',
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 4,
            bgcolor: color,
            transform: 'scaleY(0.42)',
            transformOrigin: 'center',
            transition: 'transform 180ms ease',
          },
          '&:hover': {
            bgcolor: alpha('#FFFFFF', 0.66),
            boxShadow: `0 10px 24px ${alpha(color, 0.12)}, inset 0 1px 0 #FFFFFF, inset 0 0 0 1px ${alpha(color, 0.15)}`,
            transform: 'translateY(-1px)',
          },
          '&:hover::before, &:focus-visible::before': { transform: 'scaleY(1)' },
          '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: -2 },
        }}
      >
        <Box sx={{ px: { xs: 2, md: 2.25 }, py: 2, height: '100%' }}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1.5}>
            <Box minWidth={0}>
              <Typography sx={{ fontSize: 11.5, fontWeight: 800, color: '#5E6862' }}>
                {label.toUpperCase()}
              </Typography>
              <Typography sx={{ mt: 0.55, fontSize: 29, lineHeight: 1, fontWeight: 750, color: ink }}>
                {loading ? <Skeleton width={44} /> : value}
              </Typography>
            </Box>
            <Box
              sx={{
                width: 36,
                height: 36,
                flexShrink: 0,
                display: 'grid',
                placeItems: 'center',
                bgcolor: alpha(color, 0.11),
                color,
                borderRadius: '50%',
                '& svg': { fontSize: 19 },
              }}
            >
              {icon}
            </Box>
          </Stack>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mt: 1.15 }}>
            <Typography noWrap sx={{ minWidth: 0, fontSize: 11.5, color: '#707A74' }}>
              {note}
            </Typography>
            <ArrowForwardOutlinedIcon sx={{ fontSize: 15, color: alpha(color, 0.7), flexShrink: 0 }} />
          </Stack>
        </Box>
      </Box>
    </Tooltip>
  );
}

function RailMetric({
  label,
  value,
  note,
  color,
  loading,
}: {
  label: string;
  value: React.ReactNode;
  note: string;
  color: string;
  loading?: boolean;
}) {
  return (
    <Box sx={{ py: 2.1, borderBottom: `1px solid ${alpha('#FFFFFF', 0.12)}` }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
        <Typography sx={{ color: alpha('#FFFFFF', 0.62), fontSize: 11, fontWeight: 700 }}>
          {label}
        </Typography>
        <Box sx={{ width: 7, height: 7, bgcolor: color, mt: 0.5, flexShrink: 0 }} />
      </Stack>
      <Typography sx={{ color: '#FFFFFF', fontSize: 31, fontWeight: 700, lineHeight: 1.15, mt: 0.5 }}>
        {loading ? <Skeleton width={54} sx={{ bgcolor: alpha('#FFFFFF', 0.14) }} /> : value}
      </Typography>
      <Typography sx={{ color: alpha('#FFFFFF', 0.52), fontSize: 11, mt: 0.35 }}>{note}</Typography>
    </Box>
  );
}

function RankedBars({
  rows,
  color,
  emptyText,
  valueLabel,
}: {
  rows: { label: string; value: number }[];
  color: string;
  emptyText: string;
  valueLabel: string;
}) {
  if (!rows.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 5, textAlign: 'center' }}>
        {emptyText}
      </Typography>
    );
  }
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <Stack spacing={2}>
      {rows.slice(0, 6).map((row, index) => (
        <Box key={row.label}>
          <Stack direction="row" alignItems="baseline" justifyContent="space-between" spacing={2}>
            <Stack direction="row" spacing={1.25} minWidth={0} alignItems="baseline">
              <Typography sx={{ fontFamily: 'monospace', fontSize: 10.5, color: '#737C77' }}>
                {String(index + 1).padStart(2, '0')}
              </Typography>
              <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 650, color: ink }}>
                {row.label}
              </Typography>
            </Stack>
            <Typography sx={{ fontSize: 12, fontWeight: 750, color: ink, flexShrink: 0 }}>
              {number(row.value)} <Box component="span" sx={{ color: '#737C77', fontSize: 10.5 }}>{valueLabel}</Box>
            </Typography>
          </Stack>
          <Box sx={{ ml: 3.6, mt: 0.8, height: 7, bgcolor: '#E8E5DE', overflow: 'hidden' }}>
            <Box
              sx={{
                height: '100%',
                width: `${Math.max((row.value / max) * 100, 3)}%`,
                bgcolor: color,
                transition: 'width 500ms ease',
              }}
            />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

type VendorChartFocus = { dayIndex: number; vendorIndex: number | null };

function DetailBars({ split, color }: { split: Record<string, number>; color: string }) {
  const rows = Object.entries(split).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...rows.map(([, value]) => value), 1);

  if (!rows.length) {
    return (
      <Typography sx={{ py: 3, fontSize: 12, color: alpha('#FFFFFF', 0.5), textAlign: 'center' }}>
        No designation activity
      </Typography>
    );
  }

  return (
    <Stack spacing={1.35}>
      {rows.slice(0, 8).map(([designation, value]) => (
        <Box key={designation}>
          <Stack direction="row" justifyContent="space-between" spacing={1.5}>
            <Typography noWrap sx={{ fontSize: 12.5, color: alpha('#FFFFFF', 0.86) }}>
              {designation}
            </Typography>
            <Typography sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 800, color: '#FFFFFF' }}>
              {value}
            </Typography>
          </Stack>
          <Box sx={{ height: 5, mt: 0.7, bgcolor: alpha('#FFFFFF', 0.1) }}>
            <Box sx={{ width: `${Math.max((value / max) * 100, 4)}%`, height: '100%', bgcolor: color }} />
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

function VendorLabourChart({ trend }: { trend: VendorTrendData }) {
  const [windowDays, setWindowDays] = React.useState<7 | 14 | 30>(14);
  const view = React.useMemo(() => {
    const offset = Math.max(0, trend.days.length - windowDays);
    return {
      days: trend.days.slice(offset),
      series: trend.series.map((series) => ({
        ...series,
        data: series.data.slice(offset),
        splits: series.splits.slice(offset),
      })),
      totals: trend.totals.slice(offset),
      totalSplits: trend.totalSplits.slice(offset),
      otherTotals: trend.otherTotals.slice(offset),
    };
  }, [trend, windowDays]);
  const latestIndex = Math.max(view.days.length - 1, 0);
  const [focus, setFocus] = React.useState<VendorChartFocus>({
    dayIndex: latestIndex,
    vendorIndex: null,
  });

  React.useEffect(() => {
    setFocus({ dayIndex: Math.max(view.days.length - 1, 0), vendorIndex: null });
  }, [view.days.length, windowDays, trend.days]);

  const safeDay = Math.min(focus.dayIndex, latestIndex);
  const selectedDate = view.days[safeDay];
  const selectedVendor =
    focus.vendorIndex == null ? null : view.series[focus.vendorIndex] ?? null;
  const selectedTotal = selectedVendor
    ? selectedVendor.data[safeDay] ?? 0
    : view.totals[safeDay] ?? 0;
  const selectedSplit = selectedVendor
    ? selectedVendor.splits[safeDay] ?? {}
    : view.totalSplits[safeDay] ?? {};
  const maxValue = Math.max(...view.series.flatMap((series) => series.data), 1);
  const scaleTop = Math.max(5, Math.ceil(maxValue / 5) * 5);
  const ticks = [scaleTop, Math.round(scaleTop * 0.75), Math.round(scaleTop * 0.5), Math.round(scaleTop * 0.25), 0];

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1fr) 305px' } }}>
      <Box sx={{ minWidth: 0, borderRight: { lg: `1px solid ${line}` } }}>
        <Box
          sx={{
            px: { xs: 2, md: 2.5 },
            py: 1.15,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1.5,
            flexWrap: 'wrap',
            borderBottom: `1px solid ${line}`,
            bgcolor: '#F8F7F2',
          }}
        >
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
            {view.series.map((series, index) => (
              <Stack key={series.vendor} direction="row" spacing={0.65} alignItems="center">
                <Box sx={{ width: 8, height: 8, bgcolor: vendorColors[index % vendorColors.length] }} />
              <Typography sx={{ fontSize: 12, fontWeight: 750, color: '#4E5852' }}>
                  {series.vendor}
                </Typography>
              </Stack>
            ))}
            {trend.hiddenVendorCount > 0 && (
              <Typography sx={{ fontSize: 11.5, color: '#6E7772' }}>
                +{trend.hiddenVendorCount} more
              </Typography>
            )}
          </Stack>
          <Box sx={{ display: 'flex', p: 0.35, bgcolor: '#E9E7E0', borderRadius: 1, flexShrink: 0 }}>
            {([7, 14, 30] as const).map((days) => (
              <Button
                key={days}
                size="small"
                aria-pressed={windowDays === days}
                onClick={() => setWindowDays(days)}
                sx={{
                  minWidth: 42,
                  px: 1,
                  py: 0.35,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: windowDays === days ? '#FFFFFF' : '#68716C',
                  bgcolor: windowDays === days ? ink : 'transparent',
                  '&:hover': { bgcolor: windowDays === days ? ink : alpha(ink, 0.07) },
                }}
              >
                {days}D
              </Button>
            ))}
          </Box>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: '42px minmax(0, 1fr)', px: { xs: 1, md: 1.5 }, py: 1.5 }}>
          <Box sx={{ height: 302, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', pb: '34px' }}>
            {ticks.map((tick, index) => (
              <Typography
                key={`${tick}-${index}`}
                sx={{ fontFamily: 'monospace', fontSize: 10.5, color: '#68716C', textAlign: 'right', pr: 1 }}
              >
                {tick}
              </Typography>
            ))}
          </Box>
          <Box sx={{ overflowX: 'auto', overflowY: 'hidden', pb: 0.5 }}>
            <Box
              sx={{
                position: 'relative',
                height: 302,
                minWidth: {
                  xs: windowDays === 30 ? 840 : windowDays === 14 ? 520 : 340,
                  md: '100%',
                },
              }}
            >
              {[0, 25, 50, 75, 100].map((top) => (
                <Box
                  key={top}
                  sx={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: `${top}%`,
                    borderTop: `1px ${top === 100 ? 'solid' : 'dashed'} ${top === 100 ? '#AFAEA7' : '#E2DFD7'}`,
                    pointerEvents: 'none',
                  }}
                />
              ))}
              <Box sx={{ position: 'absolute', inset: 0, display: 'flex' }}>
                {view.days.map((day, dayIndex) => {
                  const active = safeDay === dayIndex;
                  const date = new Date(`${day}T00:00:00`);
                  const showMonth = dayIndex === 0 || date.getDate() === 1;
                  const showDay = windowDays !== 30 || dayIndex % 2 === 0 || dayIndex === view.days.length - 1;
                  const activeVendors = view.series
                    .map((series, vendorIndex) => ({
                      series,
                      vendorIndex,
                      value: series.data[dayIndex] ?? 0,
                    }))
                    .filter(({ value }) => value > 0);
                  const barMaxWidth = windowDays === 7
                    ? activeVendors.length === 1 ? 32 : 22
                    : windowDays === 14
                      ? activeVendors.length === 1 ? 22 : activeVendors.length === 2 ? 18 : 14
                      : activeVendors.length === 1 ? 14 : activeVendors.length === 2 ? 11 : 8;
                  return (
                    <Box
                      key={day}
                      onPointerEnter={() => setFocus({ dayIndex, vendorIndex: null })}
                      sx={{
                        flex: '1 1 0',
                        minWidth:
                          windowDays === 30
                            ? 46
                            : windowDays === 14
                              ? 72
                              : 92,
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        bgcolor: active ? alpha(teal, 0.045) : 'transparent',
                        borderLeft: active ? `1px solid ${alpha(teal, 0.18)}` : '1px solid transparent',
                        borderRight: active ? `1px solid ${alpha(teal, 0.18)}` : '1px solid transparent',
                        transition: 'background-color 120ms ease',
                      }}
                    >
                      <Box
                        onPointerMove={(event) => {
                          if (event.target === event.currentTarget) {
                            setFocus({ dayIndex, vendorIndex: null });
                          }
                        }}
                        sx={{
                          flex: 1,
                          minHeight: 0,
                          px: 0.5,
                          display: 'flex',
                          alignItems: 'flex-end',
                          justifyContent: 'center',
                          gap: '3px',
                        }}
                      >
                        {activeVendors.map(({ series, vendorIndex, value }) => {
                          const isFocused = active && focus.vendorIndex === vendorIndex;
                          return (
                            <Box
                              key={series.vendor}
                              role="img"
                              aria-label={`${series.vendor}, ${formatDay(day, true)}, ${value} workers`}
                              onPointerEnter={(event) => {
                                event.stopPropagation();
                                setFocus({ dayIndex, vendorIndex });
                              }}
                              sx={{
                                width: '100%',
                                maxWidth: barMaxWidth,
                                minWidth: 5,
                                height: `${Math.max((value / scaleTop) * 100, 1.5)}%`,
                                bgcolor: vendorColors[vendorIndex % vendorColors.length],
                                opacity: focus.vendorIndex == null || focus.vendorIndex === vendorIndex ? 1 : 0.3,
                                outline: isFocused ? `2px solid ${ink}` : 'none',
                                outlineOffset: 1,
                                transition: 'height 380ms ease, opacity 120ms ease',
                                cursor: 'crosshair',
                              }}
                            />
                          );
                        })}
                      </Box>
                      <Box
                        onPointerEnter={() => setFocus({ dayIndex, vendorIndex: null })}
                        sx={{ height: 36, pt: 1, textAlign: 'center', flexShrink: 0 }}
                      >
                        <Typography sx={{ fontFamily: 'monospace', fontSize: 11, fontWeight: active ? 800 : 600, color: active ? ink : '#68716C' }}>
                          {showDay ? date.getDate() : ''}
                        </Typography>
                        {showMonth && (
                          <Typography sx={{ fontSize: 10, color: '#727B76', textTransform: 'uppercase' }}>
                            {date.toLocaleDateString(undefined, { month: 'short' })}
                          </Typography>
                        )}
                      </Box>
                    </Box>
                  );
                })}
              </Box>
            </Box>
          </Box>
        </Box>
      </Box>

      <Box sx={{ bgcolor: ink, color: '#FFFFFF', minHeight: 354, p: 2 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
          <Box minWidth={0}>
            <Typography sx={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 800, color: amber }}>
              {selectedVendor ? 'VENDOR DETAIL' : 'ALL VENDORS'}
            </Typography>
            <Typography sx={{ mt: 0.8, fontSize: 17, lineHeight: 1.2, fontWeight: 720, overflowWrap: 'anywhere' }}>
              {selectedVendor?.vendor ?? 'All vendors'}
            </Typography>
            <Typography sx={{ mt: 0.25, fontSize: 11, color: alpha('#FFFFFF', 0.52) }}>
              {selectedDate ? formatDay(selectedDate, true) : 'No date selected'}
            </Typography>
          </Box>
          <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
            <Typography sx={{ fontSize: 31, fontWeight: 750, lineHeight: 1 }}>{selectedTotal}</Typography>
            <Typography sx={{ mt: 0.4, fontSize: 10.5, color: alpha('#FFFFFF', 0.58) }}>WORKERS</Typography>
          </Box>
        </Stack>

        <Divider sx={{ my: 1.5, borderColor: alpha('#FFFFFF', 0.13) }} />
        <Typography sx={{ mb: 1, fontSize: 11, fontWeight: 800, color: alpha('#FFFFFF', 0.58) }}>
          WORKERS BY DESIGNATION
        </Typography>
        <Box sx={{ maxHeight: 112, overflowY: 'auto', pr: 0.5 }}>
          <DetailBars
            split={selectedSplit}
            color={selectedVendor ? vendorColors[focus.vendorIndex! % vendorColors.length] : amber}
          />
        </Box>

        {!selectedVendor && (
          <>
            <Divider sx={{ my: 1.5, borderColor: alpha('#FFFFFF', 0.13) }} />
            <Typography sx={{ mb: 0.75, fontSize: 11, fontWeight: 800, color: alpha('#FFFFFF', 0.58) }}>
              WORKERS BY VENDOR
            </Typography>
            <Stack spacing={0.35}>
              {view.series.map((series, index) => (
                <Stack key={series.vendor} direction="row" alignItems="center" spacing={1}>
                  <Box sx={{ width: 9, height: 9, bgcolor: vendorColors[index % vendorColors.length] }} />
                  <Typography noWrap sx={{ flex: 1, fontSize: 11.5, color: alpha('#FFFFFF', 0.82) }}>
                    {series.vendor}
                  </Typography>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 11.5, fontWeight: 800 }}>
                    {series.data[safeDay] ?? 0}
                  </Typography>
                </Stack>
              ))}
              {(view.otherTotals[safeDay] ?? 0) > 0 && (
                <Stack direction="row" justifyContent="space-between">
                  <Typography sx={{ fontSize: 10.5, color: alpha('#FFFFFF', 0.5) }}>
                    Other vendors ({trend.hiddenVendorCount})
                  </Typography>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 10.5, fontWeight: 800 }}>
                    {view.otherTotals[safeDay]}
                  </Typography>
                </Stack>
              )}
            </Stack>
          </>
        )}
      </Box>
    </Box>
  );
}

const donutColors = ['#19C7D4', '#FF7A00', '#F4C430', '#3887D7', '#EF5B3E', '#A5D84E', '#E7EDF0'];

function VendorMixDonut({ rows }: { rows: { vendor: string; count: number }[] }) {
  const [activeIndex, setActiveIndex] = React.useState<number | null>(null);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const visibleRows = rows.slice(0, 6);
  const remaining = rows.slice(6).reduce((sum, row) => sum + row.count, 0);
  const slices = remaining
    ? [...visibleRows, { vendor: 'Other vendors', count: remaining }]
    : visibleRows;
  let cursor = 0;
  const stops = slices.map((row, index) => {
    const start = cursor;
    const end = total ? cursor + (row.count / total) * 360 : cursor;
    cursor = end;
    const gap = Math.min(1.4, Math.max((end - start) * 0.08, 0.35));
    const baseColor = donutColors[index % donutColors.length];
    const color = activeIndex == null || activeIndex === index ? baseColor : alpha(baseColor, 0.16);
    return `${color} ${start + gap}deg ${Math.max(start + gap, end - gap)}deg, transparent ${Math.max(start + gap, end - gap)}deg ${end}deg`;
  });
  const gradient = total
    ? `conic-gradient(from -28deg, ${stops.join(', ')})`
    : `conic-gradient(${alpha('#FFFFFF', 0.1)} 0deg 360deg)`;
  const selected = activeIndex == null ? null : slices[activeIndex];

  return (
    <Box
      sx={{
        minHeight: 300,
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '270px minmax(0, 1fr)' },
        alignItems: 'center',
        gap: { xs: 2, md: 3 },
        px: { xs: 2, md: 3 },
        py: 2.5,
        backgroundImage: `linear-gradient(${alpha('#FFFFFF', 0.025)} 1px, transparent 1px), linear-gradient(90deg, ${alpha('#FFFFFF', 0.025)} 1px, transparent 1px)`,
        backgroundSize: '28px 28px',
      }}
    >
      <Stack alignItems="center" justifyContent="center">
        <Box
          role="img"
          aria-label={`Attendance by vendor, ${total} total worker attendance`}
          sx={{
            position: 'relative',
            width: { xs: 200, sm: 220 },
            aspectRatio: '1',
            borderRadius: '50%',
            background: gradient,
            filter: 'drop-shadow(0 14px 24px rgba(0,0,0,0.2))',
            transition: 'background 180ms ease',
            '&::after': {
              content: '""',
              position: 'absolute',
              inset: '29%',
              borderRadius: '50%',
              bgcolor: '#111B22',
              border: `1px solid ${alpha('#FFFFFF', 0.12)}`,
              boxShadow: `inset 0 0 24px ${alpha('#000000', 0.45)}, 0 0 0 7px ${alpha('#FFFFFF', 0.025)}`,
            },
          }}
        >
          <Stack sx={{ position: 'absolute', inset: '29%', zIndex: 1, px: 0.5 }} alignItems="center" justifyContent="center">
            <Typography
              sx={{
                maxWidth: 82,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                fontSize: selected ? 9 : 9.5,
                lineHeight: 1.15,
                color: alpha('#FFFFFF', 0.58),
                textAlign: 'center',
              }}
            >
              {selected?.vendor ?? 'TOTAL ATTENDANCE'}
            </Typography>
            <Typography sx={{ mt: 0.45, fontSize: 25, lineHeight: 1, fontWeight: 760, color: '#FFFFFF' }}>
              {number(selected?.count ?? total)}
            </Typography>
            {selected && (
              <Typography sx={{ mt: 0.45, fontFamily: 'monospace', fontSize: 10, fontWeight: 800, color: donutColors[activeIndex! % donutColors.length] }}>
                {total ? Math.round((selected.count / total) * 100) : 0}%
              </Typography>
            )}
          </Stack>
        </Box>
      </Stack>

      <Box sx={{ minWidth: 0 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 64px 84px',
            gap: 1.5,
            px: 1.25,
            pb: 1,
            borderBottom: `1px solid ${alpha('#FFFFFF', 0.14)}`,
          }}
        >
          <Typography sx={{ fontSize: 10, fontWeight: 800, color: alpha('#FFFFFF', 0.5) }}>VENDOR</Typography>
          <Typography sx={{ fontSize: 10, fontWeight: 800, color: alpha('#FFFFFF', 0.5), textAlign: 'right' }}>SHARE</Typography>
          <Typography sx={{ fontSize: 10, fontWeight: 800, color: alpha('#FFFFFF', 0.5), textAlign: 'right' }}>ATTENDANCE</Typography>
        </Box>

        <Stack>
          {slices.map((row, index) => {
            const color = donutColors[index % donutColors.length];
            const percentage = total ? Math.round((row.count / total) * 100) : 0;
            const isActive = activeIndex === index;
            return (
              <Box
                key={row.vendor}
                component="button"
                type="button"
                onPointerEnter={() => setActiveIndex(index)}
                onPointerLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(index)}
                onBlur={() => setActiveIndex(null)}
                aria-label={`${row.vendor}: ${percentage}% share, ${row.count} attendance`}
                sx={{
                  appearance: 'none',
                  width: '100%',
                  px: 1.25,
                  py: 1.2,
                  border: 0,
                  borderBottom: `1px solid ${alpha('#FFFFFF', 0.08)}`,
                  bgcolor: isActive ? alpha(color, 0.11) : 'transparent',
                  color: '#FFFFFF',
                  textAlign: 'left',
                  cursor: 'default',
                  transition: 'background-color 140ms ease',
                  '&:focus-visible': { outline: `2px solid ${color}`, outlineOffset: -2 },
                }}
              >
                <Box sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 64px 84px', alignItems: 'center', gap: 1.5 }}>
                  <Stack direction="row" spacing={1.1} alignItems="center" minWidth={0}>
                    <Box sx={{ width: 11, height: 11, flexShrink: 0, bgcolor: color, boxShadow: isActive ? `0 0 12px ${alpha(color, 0.8)}` : 'none' }} />
                    <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700, color: '#F4F7F6' }}>
                      {row.vendor}
                    </Typography>
                  </Stack>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 800, textAlign: 'right', color }}>
                    {percentage}%
                  </Typography>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 800, textAlign: 'right' }}>
                    {number(row.count)}
                  </Typography>
                </Box>
                <Box sx={{ mt: 0.75, ml: 2.75, height: 3, bgcolor: alpha('#FFFFFF', 0.08), overflow: 'hidden' }}>
                  <Box sx={{ width: `${Math.max(percentage, 1)}%`, height: '100%', bgcolor: color, transition: 'width 300ms ease' }} />
                </Box>
              </Box>
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

export default function DashboardRedesignPage() {
  const router = useRouter();
  const [range, setRange] = React.useState(defaultRange);
  const [glassReady, setGlassReady] = React.useState(false);

  const spanDays =
    Math.round(
      (new Date(`${range.to}T00:00:00`).getTime() - new Date(`${range.from}T00:00:00`).getTime()) /
        86_400_000,
    ) + 1;
  const atToday = range.to >= isoDay(new Date());
  const moveRange = (direction: -1 | 1) =>
    setRange((current) => ({
      from: shiftDays(current.from, direction * spanDays),
      to: shiftDays(current.to, direction * spanDays),
    }));

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });
  const pending = useQuery({
    queryKey: ['corrections', 'PENDING'],
    queryFn: () => api.get<CorrectionRequest[]>('/corrections?status=PENDING'),
  });
  const stats = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => api.get<DashboardStats>('/attendance/dashboard-stats'),
    refetchInterval: 30_000,
  });
  const charts = useQuery({
    queryKey: ['dashboard-charts', range.from, range.to],
    queryFn: () =>
      api.get<DashboardCharts>(`/attendance/dashboard-charts?from=${range.from}&to=${range.to}`),
    placeholderData: (previous) => previous,
    refetchInterval: 60_000,
  });
  const activity = useQuery({
    queryKey: ['recent-activity-redesign'],
    queryFn: () =>
      api.get<Paginated<AuditRow>>(
        '/audit?limit=6&excludeActions=ATTENDANCE_LOGIN,ATTENDANCE_LOGOUT',
      ),
    refetchInterval: 60_000,
  });

  const statsError = stats.isError
    ? apiErrorMessage(stats.error, 'Live attendance could not be loaded.')
    : null;
  const chartsError = charts.isError
    ? apiErrorMessage(charts.error, 'Operational charts could not be loaded.')
    : null;
  const sitesError = sites.isError ? apiErrorMessage(sites.error, 'Sites could not be loaded.') : null;
  const pendingError = pending.isError
    ? apiErrorMessage(pending.error, 'Corrections could not be loaded.')
    : null;
  const activityError = activity.isError
    ? apiErrorMessage(activity.error, 'Activity could not be loaded.')
    : null;
  const anyError = statsError ?? chartsError ?? sitesError ?? pendingError ?? activityError;

  const onSite = stats.data?.onSiteNow;
  const manpower = charts.data?.manpower;
  const workersInside = onSite?.byCategory.WORKER?.count ?? 0;
  const staffInside = onSite?.byCategory.STAFF?.count ?? 0;
  const visitorsInside = onSite?.byCategory.VISITOR?.count ?? 0;
  const activeSites = sites.data?.filter((site) => site.isActive).length;
  const peopleNow = Object.values(onSite?.byCategory ?? {}).flatMap((bucket) => bucket.people ?? []);
  const missedLogoutPeople = Object.values(stats.data?.missedLogout.byCategory ?? {}).flatMap(
    (bucket) => bucket.people ?? [],
  );
  const newestPeople = [...peopleNow]
    .sort((a, b) => new Date(b.loginAt).getTime() - new Date(a.loginAt).getTime())
    .slice(0, 7);
  const maxSiteLoad = Math.max(...(charts.data?.siteWise ?? []).map((site) => site.onSite), 1);
  const dayLabels = (manpower?.days ?? []).map((day) => formatDay(day));
  const dailyAttendance = manpower?.trend ?? [];
  const dailyChartMax = Math.max(...dailyAttendance, 1);
  const dailyAverage = dailyAttendance.length
    ? Math.round(dailyAttendance.reduce((sum, value) => sum + value, 0) / dailyAttendance.length)
    : 0;
  const busiestSite = charts.data?.siteWise?.[0];
  const topVendor = charts.data?.vendorToday?.[0];
  const topTrade = manpower?.byTrade?.[0];
  const peopleDetails = (people: StatPerson[]): HoverDetail[] =>
    people.map((person) => ({
      primary: `${person.fullName} (${person.workerCode})`,
      secondary: `${person.siteName ?? 'Site not assigned'} · ${new Date(person.loginAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    }));

  const retryAll = () => {
    void Promise.all([
      stats.refetch(),
      charts.refetch(),
      sites.refetch(),
      pending.refetch(),
      activity.refetch(),
    ]);
  };

  return (
    <Box
      className={dashboardFont.className}
      sx={{
        mx: { xs: -2, md: -3 },
        mt: { xs: -2, md: -3 },
        minHeight: 'calc(100vh - 64px)',
        bgcolor: '#EEF2F0',
        backgroundImage: `linear-gradient(116deg, ${alpha('#1A746B', 0.08)} 0 14%, transparent 14% 66%, ${alpha('#3B6484', 0.07)} 66% 78%, transparent 78%), linear-gradient(90deg, ${alpha('#FFFFFF', 0.42)} 1px, transparent 1px), linear-gradient(${alpha('#FFFFFF', 0.38)} 1px, transparent 1px)`,
        backgroundSize: '100% 100%, 36px 36px, 36px 36px',
        backgroundAttachment: 'fixed',
        color: ink,
        fontFamily: dashboardFont.style.fontFamily,
        '& .MuiTypography-root, & .MuiButton-root, & .MuiInputBase-root, & .MuiChip-root': {
          fontFamily: dashboardFont.style.fontFamily,
        },
      }}
    >
      <Script
        src="/vendor/liquid-glass/liquid-glass.js"
        strategy="afterInteractive"
        onReady={() => setGlassReady(true)}
      />
      <Box
        sx={{
          px: { xs: 2, md: 3.5 },
          pt: { xs: 2.5, md: 3 },
          pb: 2.5,
          bgcolor: 'rgba(255, 255, 255, 0.72)',
          backdropFilter: 'blur(20px) saturate(1.15)',
          WebkitBackdropFilter: 'blur(20px) saturate(1.15)',
          borderBottom: `1px solid ${line}`,
          boxShadow: `0 8px 28px ${alpha('#1D382F', 0.06)}, inset 0 1px 0 ${alpha('#FFFFFF', 0.9)}`,
        }}
      >
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          alignItems={{ xs: 'stretch', md: 'center' }}
          justifyContent="space-between"
          spacing={2}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.9 }}>
              <Box sx={{ width: 26, height: 3, bgcolor: amber }} />
              <Typography sx={{ fontFamily: 'monospace', fontSize: 10.5, fontWeight: 800, color: teal }}>
                OPERATIONS / LIVE
              </Typography>
            </Stack>
            <Typography
              component="h1"
              sx={{ fontSize: { xs: 27, md: 34 }, lineHeight: 1, fontWeight: 720, color: ink }}
            >
              Live site operations
            </Typography>
            <Typography sx={{ mt: 0.8, fontSize: 12.5, color: '#65706A' }}>
              Attendance movement, site pressure and exceptions in one working view.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Chip
              icon={<AccessTimeOutlinedIcon />}
              label={`Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              variant="outlined"
              sx={{ borderRadius: 1, borderColor: line, bgcolor: '#FFFFFF' }}
            />
            <Button
              variant="outlined"
              startIcon={<PersonAddAltOutlinedIcon />}
              onClick={() => router.push('/workers')}
              sx={{ borderColor: line, color: ink, bgcolor: '#FFFFFF' }}
            >
              Add worker
            </Button>
            <Button
              variant="outlined"
              startIcon={<AddLocationAltOutlinedIcon />}
              onClick={() => router.push('/sites')}
              sx={{ borderColor: line, color: ink, bgcolor: '#FFFFFF' }}
            >
              Add site
            </Button>
            <Button
              variant="outlined"
              startIcon={<FactCheckOutlinedIcon />}
              onClick={() => router.push('/corrections')}
              sx={{ borderColor: line, color: ink, bgcolor: '#FFFFFF' }}
            >
              Corrections
            </Button>
            <Tooltip title="Refresh dashboard data">
              <IconButton
                onClick={retryAll}
                sx={{ border: `1px solid ${line}`, borderRadius: 1, bgcolor: '#FFFFFF' }}
              >
                <RefreshOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        </Stack>
      </Box>

      <Box sx={{ px: { xs: 2, md: 3.5 }, py: { xs: 2, md: 3 } }}>
        {anyError && (
          <Alert
            severity="error"
            sx={{ mb: 2, borderRadius: 1 }}
            action={<Button onClick={retryAll}>Retry all</Button>}
          >
            {anyError}
          </Alert>
        )}

        <Box
          sx={{
            ...panelSx,
            mb: 1.5,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
            gap: '1px',
            bgcolor: line,
            overflow: 'hidden',
          }}
        >
          <StatusMetric
            label="Workers on site"
            value={number(workersInside)}
            note="Logged in right now"
            icon={<EngineeringOutlinedIcon />}
            color={teal}
            loading={stats.isLoading}
            onClick={() => router.push('/attendance?category=WORKER')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Workers on site now"
                items={peopleDetails(onSite?.byCategory.WORKER?.people ?? [])}
                emptyText="No workers are on site right now."
              />
            }
          />
          <StatusMetric
            label="Staff on site"
            value={number(staffInside)}
            note="Supervisors and office staff"
            icon={<BadgeOutlinedIcon />}
            color={blue}
            loading={stats.isLoading}
            onClick={() => router.push('/attendance?category=STAFF')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Staff on site now"
                items={peopleDetails(onSite?.byCategory.STAFF?.people ?? [])}
                emptyText="No staff are on site right now."
              />
            }
          />
          <StatusMetric
            label="Visitors on site"
            value={number(visitorsInside)}
            note="Temporary check-ins"
            icon={<GroupsOutlinedIcon />}
            color={violet}
            loading={stats.isLoading}
            onClick={() => router.push('/attendance?category=VISITOR')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Visitors on site now"
                items={peopleDetails(onSite?.byCategory.VISITOR?.people ?? [])}
                emptyText="No visitors are on site right now."
              />
            }
          />
          <StatusMetric
            label="Total on site"
            value={number(onSite?.total)}
            note="All attendance categories"
            icon={<GroupsOutlinedIcon />}
            color="#2878A8"
            loading={stats.isLoading}
            onClick={() => router.push('/attendance')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Everyone on site now"
                items={peopleDetails(peopleNow)}
                emptyText="No one is on site right now."
              />
            }
          />
          <StatusMetric
            label="Missed logouts"
            value={number(stats.data?.missedLogout.total)}
            note="Open sessions to review"
            icon={<WarningAmberOutlinedIcon />}
            color={rust}
            loading={stats.isLoading}
            onClick={() => router.push('/attendance?view=missed')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="People who missed logout"
                items={peopleDetails(missedLogoutPeople)}
                emptyText="No missed logouts need review."
              />
            }
          />
          <StatusMetric
            label="Pending corrections"
            value={number(pending.data?.length)}
            note="Awaiting admin review"
            icon={<FactCheckOutlinedIcon />}
            color={amber}
            loading={pending.isLoading}
            onClick={() => router.push('/corrections')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Corrections waiting for review"
                items={(pending.data ?? []).map((request) => ({
                  primary: request.worker
                    ? `${request.worker.fullName} (${request.worker.workerCode})`
                    : request.requestedByName ?? 'Attendance correction',
                  secondary: `${request.type.replace(/_/g, ' ').toLowerCase()} · ${formatDay(request.workDate, true)}`,
                }))}
                emptyText="No corrections are waiting for review."
              />
            }
          />
          <StatusMetric
            label="Active sites"
            value={number(activeSites)}
            note="Currently operational"
            icon={<LocationOnOutlinedIcon />}
            color="#2C8C5E"
            loading={sites.isLoading}
            onClick={() => router.push('/sites')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="Active sites"
                items={(sites.data ?? []).filter((site) => site.isActive).map((site) => ({
                  primary: site.name,
                  secondary: site.code,
                }))}
                emptyText="No sites are currently active."
              />
            }
          />
          <StatusMetric
            label="Total sites"
            value={number(sites.data?.length)}
            note="Including completed sites"
            icon={<MapOutlinedIcon />}
            color="#5C6BB2"
            loading={sites.isLoading}
            onClick={() => router.push('/sites')}
            glassReady={glassReady}
            tooltip={
              <MetricHoverCard
                title="All sites"
                items={(sites.data ?? []).map((site) => ({
                  primary: site.name,
                  secondary: `${site.code} · ${site.isActive ? 'Active' : 'Inactive'}`,
                }))}
                emptyText="No sites have been added yet."
              />
            }
          />
        </Box>

        <Box sx={{ ...panelSx, mb: 1.5, overflow: 'hidden' }}>
          <SectionHeading
            index="01"
            title="Vendor attendance by day"
            subtitle="Workers present from each vendor during the last 30 days"
            action={
              <Stack direction="row" spacing={2.5} alignItems="center">
                <Box sx={{ textAlign: 'right' }}>
                  <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: '#737C77' }}>VENDORS</Typography>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 800 }}>
                    {number(charts.data?.vendorTrend.series.length)}
                  </Typography>
                </Box>
                <Box sx={{ textAlign: 'right' }}>
                  <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: '#737C77' }}>30-DAY ATTENDANCE</Typography>
                  <Typography sx={{ fontFamily: 'monospace', fontSize: 15, fontWeight: 800 }}>
                    {number(charts.data?.vendorTrend.totals.reduce((sum, value) => sum + value, 0))}
                  </Typography>
                </Box>
              </Stack>
            }
          />
          <QueryState
            loading={charts.isLoading}
            error={chartsError}
            empty={(charts.data?.vendorTrend.series.length ?? 0) === 0}
            emptyText="No vendor attendance in the last 30 days"
            height={410}
            onRetry={() => void charts.refetch()}
          >
            {charts.data?.vendorTrend && <VendorLabourChart trend={charts.data.vendorTrend} />}
          </QueryState>
        </Box>

        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              lg: '220px minmax(0, 1fr)',
              xl: '220px minmax(0, 1fr) 300px',
            },
            gap: 1.5,
            alignItems: 'stretch',
          }}
        >
          <Box
            sx={{
              bgcolor: ink,
              color: '#FFFFFF',
              borderRadius: '4px',
              px: 2.25,
              py: 1.5,
              minHeight: { lg: 430 },
            }}
          >
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ pb: 0.5 }}>
              <Typography sx={{ fontSize: 11.5, fontWeight: 800, letterSpacing: 0 }}>SELECTED PERIOD</Typography>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: amber }} />
            </Stack>
            <RailMetric
              label="TOTAL ATTENDANCE"
              value={number(manpower?.totalManDays)}
              note="Sum of workers present each day"
              color={amber}
              loading={charts.isLoading}
            />
            <RailMetric
              label="WORK HOURS TODAY"
              value={number(manpower?.manHoursToday == null ? null : Math.round(manpower.manHoursToday))}
              note="Total work hours recorded today"
              color="#6CA7D0"
              loading={charts.isLoading}
            />
            <RailMetric
              label="DESIGNATIONS"
              value={number(manpower?.activeTrades)}
              note="Job roles recorded in this period"
              color="#4CC38A"
              loading={charts.isLoading}
            />
            <RailMetric
              label="AVG WORKERS / DAY"
              value={number(manpower ? Math.round(manpower.totalManDays / Math.max(spanDays, 1)) : null)}
              note="Average workers present per day"
              color={violet}
              loading={charts.isLoading}
            />
            <Button
              fullWidth
              endIcon={<ArrowForwardOutlinedIcon />}
              onClick={() => router.push('/attendance')}
              sx={{ mt: 2, justifyContent: 'space-between', bgcolor: amber, color: ink, '&:hover': { bgcolor: '#CF9421' } }}
            >
              Open attendance
            </Button>
          </Box>

          <Box sx={panelSx}>
            <SectionHeading
              index="02"
              title="Daily attendance"
              subtitle="Total workers present on each day in the selected period"
              action={
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: '32px minmax(104px, 1fr) minmax(104px, 1fr) 32px',
                    alignItems: 'center',
                    gap: 0.25,
                    width: { xs: '100%', sm: 330 },
                  }}
                >
                  <Tooltip title="Previous period">
                    <IconButton size="small" onClick={() => moveRange(-1)}>
                      <ChevronLeftIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <TextField
                    type="date"
                    value={range.from}
                    onChange={(event) => event.target.value && setRange((current) => ({ ...current, from: event.target.value }))}
                    inputProps={{ 'aria-label': 'Period start' }}
                    sx={{ minWidth: 0, '& fieldset': { borderColor: line } }}
                  />
                  <TextField
                    type="date"
                    value={range.to}
                    onChange={(event) => event.target.value && setRange((current) => ({ ...current, to: event.target.value }))}
                    inputProps={{ 'aria-label': 'Period end' }}
                    sx={{ minWidth: 0, '& fieldset': { borderColor: line } }}
                  />
                  <Tooltip title={atToday ? 'Latest period selected' : 'Next period'}>
                    <span>
                      <IconButton size="small" disabled={atToday} onClick={() => moveRange(1)}>
                        <ChevronRightIcon fontSize="small" />
                      </IconButton>
                    </span>
                  </Tooltip>
                </Box>
              }
            />
            <QueryState
              loading={charts.isLoading}
              error={chartsError}
              empty={(manpower?.trend ?? []).every((value) => value === 0)}
              emptyText="No attendance recorded in this period"
              height={360}
              onRetry={() => void charts.refetch()}
            >
              <Box sx={{ px: { xs: 1, md: 2 }, pt: 1 }}>
                <Box
                  sx={{
                    position: 'relative',
                    height: 325,
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.max(dayLabels.length, 1)}, minmax(24px, 1fr))`,
                    alignItems: 'end',
                    gap: 0,
                    px: 2,
                    pt: 3,
                    borderBottom: `1px solid ${line}`,
                    backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent 64px, ${alpha(line, 0.65)} 65px)`,
                    overflowX: 'auto',
                  }}
                >
                  {dailyAverage > 0 && (
                    <Box
                      aria-label={`Average attendance: ${dailyAverage} workers`}
                      sx={{
                        position: 'absolute',
                        left: 16,
                        right: 16,
                        bottom: `${36 + (dailyAverage / dailyChartMax) * 230}px`,
                        zIndex: 0,
                        borderTop: `1px dashed ${alpha(blue, 0.58)}`,
                        pointerEvents: 'none',
                      }}
                    >
                      <Typography
                        sx={{
                          position: 'absolute',
                          left: 0,
                          top: -22,
                          px: 0.75,
                          py: 0.2,
                          bgcolor: alpha('#FFFFFF', 0.84),
                          border: `1px solid ${alpha(blue, 0.2)}`,
                          borderRadius: 0.75,
                          fontSize: 10,
                          fontWeight: 800,
                          color: blue,
                        }}
                      >
                        AVG {dailyAverage}
                      </Typography>
                    </Box>
                  )}
                  {(manpower?.trend ?? []).map((value, index) => {
                    const isLatest = index === (manpower?.trend.length ?? 0) - 1;
                    return (
                      <Tooltip key={`${dayLabels[index]}-${index}`} title={`${dayLabels[index]}: ${value} workers present`} arrow>
                        <Box
                          sx={{
                            position: 'relative',
                            zIndex: 1,
                            height: '100%',
                            minWidth: 24,
                            px: 0.75,
                            display: 'flex',
                            flexDirection: 'column',
                            justifyContent: 'flex-end',
                            alignItems: 'center',
                            transition: 'background-color 160ms ease',
                            '&:hover': { bgcolor: alpha(teal, 0.045) },
                          }}
                        >
                          <Typography sx={{ mb: 0.7, fontFamily: 'monospace', fontSize: 11, fontWeight: 800 }}>{value}</Typography>
                          <Box
                            sx={{
                              width: 'min(76px, 62%)',
                              height: `${Math.max((value / dailyChartMax) * 230, value ? 7 : 0)}px`,
                              borderRadius: '4px 4px 1px 1px',
                              background: isLatest
                                ? `linear-gradient(180deg, #F2B632 0%, ${amber} 100%)`
                                : `linear-gradient(180deg, #248479 0%, ${teal} 100%)`,
                              boxShadow: `0 8px 18px ${alpha(isLatest ? amber : teal, 0.12)}, inset 1px 0 ${alpha('#FFFFFF', 0.16)}, inset -1px 0 ${alpha('#000000', 0.08)}`,
                              transition: 'height 350ms ease, width 180ms ease, filter 160ms ease',
                              '&:hover': { filter: 'brightness(1.08)' },
                            }}
                          />
                          <Typography sx={{ mt: 0.8, mb: 0.6, fontSize: 10.5, color: '#68716C' }}>{dayLabels[index]}</Typography>
                        </Box>
                      </Tooltip>
                    );
                  })}
                </Box>
              </Box>
            </QueryState>
            <Box
              sx={{
                borderTop: `1px solid ${line}`,
                display: 'grid',
                gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
              }}
            >
              {[
                ['WORKERS TODAY', number(manpower?.totalToday)],
                ['WORK HOURS TODAY', number(manpower?.manHoursToday)],
                ['DESIGNATIONS', number(manpower?.activeTrades)],
                ['BUSIEST SITE', busiestSite?.site ?? '—'],
              ].map(([label, value], index) => (
                <Box
                  key={label}
                  sx={{
                    px: 2,
                    py: 1.5,
                    borderRight: index === 3 ? 0 : `1px solid ${line}`,
                    minWidth: 0,
                  }}
                >
                  <Typography sx={{ fontSize: 10.5, fontWeight: 800, color: '#737C77' }}>{label}</Typography>
                  <Typography noWrap sx={{ mt: 0.45, fontSize: 15, fontWeight: 720, color: ink }}>
                    {value}
                  </Typography>
                </Box>
              ))}
            </Box>
          </Box>

          <Box sx={{ ...panelSx, gridColumn: { lg: '1 / -1', xl: 'auto' } }}>
            <SectionHeading index="03" title="Recent check-ins" subtitle="Latest people who entered a site" />
            <QueryState
              loading={stats.isLoading}
              error={statsError}
              empty={newestPeople.length === 0}
              emptyText="No one has checked in yet"
              height={360}
              onRetry={() => void stats.refetch()}
            >
              <Stack divider={<Divider flexItem />}>
                {newestPeople.map((person) => (
                  <Box key={`${person.workerCode}-${person.loginAt}`} sx={{ px: 2, py: 1.45 }}>
                    <Stack direction="row" spacing={1.25} alignItems="center">
                      <Box
                        sx={{
                          width: 30,
                          height: 30,
                          flexShrink: 0,
                          display: 'grid',
                          placeItems: 'center',
                          bgcolor: alpha(teal, 0.1),
                          color: teal,
                          fontSize: 11,
                          fontWeight: 800,
                        }}
                      >
                        {person.fullName.slice(0, 2).toUpperCase()}
                      </Box>
                      <Box minWidth={0} flex={1}>
                        <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>{person.fullName}</Typography>
                        <Typography noWrap sx={{ fontSize: 10.5, color: '#747C78' }}>
                          {person.siteName ?? 'Site not assigned'}
                        </Typography>
                      </Box>
                      <Typography sx={{ fontFamily: 'monospace', fontSize: 10.5, color: '#636C67' }}>
                        {new Date(person.loginAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </Typography>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            </QueryState>
            <Box sx={{ p: 1.5, borderTop: `1px solid ${line}` }}>
              <Button fullWidth size="small" endIcon={<ArrowForwardOutlinedIcon />} onClick={() => router.push('/attendance')}>
                View live register
              </Button>
            </Box>
          </Box>
        </Box>

        <Box
          sx={{
            mt: 1.5,
          }}
        >
          <Box sx={panelSx}>
            <SectionHeading
              index="04"
              title="Workers by site"
              subtitle="How many people are currently at each site"
              action={
                <Button size="small" endIcon={<ArrowForwardOutlinedIcon />} onClick={() => router.push('/sites')}>
                  All sites
                </Button>
              }
            />
            <QueryState
              loading={charts.isLoading}
              error={chartsError}
              empty={(charts.data?.siteWise.length ?? 0) === 0}
              emptyText="No open site sessions"
              height={245}
              onRetry={() => void charts.refetch()}
            >
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(auto-fit, minmax(260px, 1fr))' },
                  gap: '1px',
                  bgcolor: line,
                }}
              >
                {(charts.data?.siteWise ?? []).slice(0, 6).map((site, index) => {
                  const percent = Math.round((site.onSite / maxSiteLoad) * 100);
                  return (
                    <Box
                      key={site.site}
                      sx={{
                        p: 2.25,
                        minHeight: 120,
                        bgcolor: 'rgba(255, 255, 255, 0.64)',
                      }}
                    >
                      <Stack direction="row" justifyContent="space-between" spacing={2} alignItems="flex-start">
                        <Box minWidth={0}>
                          <Stack direction="row" spacing={0.75} alignItems="center">
                            <LocationOnOutlinedIcon sx={{ fontSize: 15, color: teal }} />
                            <Typography noWrap sx={{ fontSize: 12.5, fontWeight: 700 }}>{site.site}</Typography>
                          </Stack>
                          <Typography sx={{ fontSize: 10.5, color: '#7A827E', mt: 0.5 }}>
                            {percent}% of highest site load
                          </Typography>
                        </Box>
                        <Typography sx={{ fontSize: 24, fontWeight: 720, lineHeight: 1 }}>{site.onSite}</Typography>
                      </Stack>
                      <LinearProgress
                        variant="determinate"
                        value={percent}
                        sx={{
                          mt: 2.2,
                          height: 7,
                          borderRadius: 0,
                          bgcolor: '#E7E4DC',
                          '& .MuiLinearProgress-bar': { bgcolor: index === 0 ? amber : teal },
                        }}
                      />
                    </Box>
                  );
                })}
              </Box>
            </QueryState>
          </Box>
        </Box>

        <Box
          sx={{
            mt: 1.5,
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              lg: 'repeat(2, minmax(0, 1fr))',
              xl: 'minmax(500px, 1.25fr) minmax(280px, 0.72fr) minmax(300px, 0.78fr)',
            },
            gap: 1.5,
          }}
        >
          <Box
            sx={{
              ...panelSx,
              gridColumn: { lg: '1 / -1', xl: 'auto' },
              overflow: 'hidden',
              bgcolor: '#111B22',
              borderColor: '#25343D',
              color: '#FFFFFF',
            }}
          >
            <Box
              sx={{
                px: 2.5,
                py: 1.75,
                minHeight: 69,
                borderBottom: `1px solid ${alpha('#FFFFFF', 0.1)}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 2,
              }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center" minWidth={0}>
                <Typography sx={{ fontFamily: 'monospace', color: '#19C7D4', fontSize: 11, fontWeight: 800 }}>
                  05
                </Typography>
                <Box minWidth={0}>
                  <Typography sx={{ fontSize: 15, fontWeight: 750, color: '#FFFFFF' }}>
                    Attendance by vendor
                  </Typography>
                  <Typography sx={{ mt: 0.35, fontSize: 11.5, color: alpha('#FFFFFF', 0.5) }}>
                    Each vendor&apos;s share of total worker attendance
                  </Typography>
                </Box>
              </Stack>
              <Typography sx={{ fontFamily: 'monospace', fontSize: 11, color: alpha('#FFFFFF', 0.58), flexShrink: 0 }}>
                {formatDay(range.from)} – {formatDay(range.to)}
              </Typography>
            </Box>
            <Box>
              <QueryState
                loading={charts.isLoading}
                error={chartsError}
                empty={(manpower?.byVendor.length ?? 0) === 0}
                emptyText="No vendor attendance"
                height={300}
                onRetry={() => void charts.refetch()}
              >
                <VendorMixDonut rows={manpower?.byVendor ?? []} />
              </QueryState>
            </Box>
          </Box>

          <Box sx={panelSx}>
            <SectionHeading index="06" title="Designations" subtitle="Job roles with the most attendance" />
            <Box sx={{ p: 2.5 }}>
              <QueryState
                loading={charts.isLoading}
                error={chartsError}
                empty={(manpower?.byTrade.length ?? 0) === 0}
                emptyText="No designation attendance"
                height={230}
                onRetry={() => void charts.refetch()}
              >
                <RankedBars
                  rows={(manpower?.byTrade ?? []).map((row) => ({ label: row.trade, value: row.count }))}
                  color={blue}
                  emptyText="No designation attendance"
                  valueLabel="attendance"
                />
              </QueryState>
            </Box>
          </Box>

          <Box sx={{ ...panelSx, bgcolor: '#FFF9EC', borderColor: '#DFC985' }}>
            <SectionHeading
              index="07"
              title="Action queue"
              subtitle="Items that can affect payroll accuracy"
              action={<WarningAmberOutlinedIcon sx={{ fontSize: 20, color: '#A86D00' }} />}
            />
            <Stack divider={<Divider flexItem />}>
              {[
                {
                  label: 'Pending corrections',
                  value: pending.data?.length,
                  note: 'Awaiting an admin decision',
                  icon: <FactCheckOutlinedIcon />,
                  href: '/corrections',
                  loading: pending.isLoading,
                },
                {
                  label: 'Missed logouts',
                  value: stats.data?.missedLogout.total,
                  note: 'Open sessions from the previous day',
                  icon: <AccessTimeOutlinedIcon />,
                  href: '/attendance?view=missed',
                  loading: stats.isLoading,
                },
                {
                  label: 'Sites with corrections',
                  value: charts.data?.correctionsBySite.length,
                  note: 'Locations requiring review',
                  icon: <LocationOnOutlinedIcon />,
                  href: '/corrections',
                  loading: charts.isLoading,
                },
              ].map((item) => (
                <Button
                  key={item.label}
                  onClick={() => router.push(item.href)}
                  sx={{ px: 2.25, py: 1.75, color: ink, justifyContent: 'stretch', borderRadius: 0 }}
                >
                  <Stack direction="row" alignItems="center" spacing={1.5} width="100%">
                    <Box sx={{ color: '#A86D00', '& svg': { fontSize: 19 } }}>{item.icon}</Box>
                    <Box minWidth={0} flex={1} textAlign="left">
                      <Typography sx={{ fontSize: 12.5, fontWeight: 700 }}>{item.label}</Typography>
                      <Typography noWrap sx={{ fontSize: 10.5, color: '#7A704E' }}>{item.note}</Typography>
                    </Box>
                    <Typography sx={{ fontSize: 20, fontWeight: 750 }}>
                      {item.loading ? <Skeleton width={24} /> : number(item.value)}
                    </Typography>
                    <ArrowForwardOutlinedIcon sx={{ fontSize: 17 }} />
                  </Stack>
                </Button>
              ))}
            </Stack>
          </Box>
        </Box>

        <Box
          sx={{
            mt: 1.5,
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.4fr) minmax(300px, 0.6fr)' },
            gap: 1.5,
          }}
        >
          <Box sx={panelSx}>
            <SectionHeading
              index="08"
              title="Operations log"
              subtitle="Recent administrative activity"
              action={
                <Button size="small" endIcon={<ArrowForwardOutlinedIcon />} onClick={() => router.push('/audit')}>
                  Full log
                </Button>
              }
            />
            <QueryState
              loading={activity.isLoading}
              error={activityError}
              empty={(activity.data?.data.length ?? 0) === 0}
              emptyText="No recent activity"
              height={210}
              onRetry={() => void activity.refetch()}
            >
              <Stack divider={<Divider flexItem />}>
                {(activity.data?.data ?? []).map((row) => (
                  <Box
                    key={row.id}
                    sx={{
                      px: 2.5,
                      py: 1.35,
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '120px minmax(0, 1fr)' },
                      gap: 1.5,
                    }}
                  >
                    <Typography sx={{ fontFamily: 'monospace', fontSize: 10.5, color: '#7C8580' }}>
                      {new Date(row.createdAt).toLocaleString(undefined, {
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Typography>
                    <Typography noWrap sx={{ fontSize: 12 }}>
                      <Box component="span" sx={{ fontWeight: 750 }}>{row.actorName ?? 'System'}</Box>{' '}
                      {activityLabels[row.action] ?? row.action.replace(/_/g, ' ').toLowerCase()}
                      {row.entityName ? ` · ${row.entityName}` : ''}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </QueryState>
          </Box>

          <Box sx={{ ...panelSx, bgcolor: ink, color: '#FFFFFF', borderColor: ink }}>
            <Box sx={{ p: 2.5 }}>
              <Typography sx={{ fontFamily: 'monospace', fontSize: 11, color: amber, fontWeight: 800 }}>
                CURRENT HIGHLIGHTS
              </Typography>
              <Stack spacing={2.5} sx={{ mt: 2.5 }}>
                {[
                  { icon: <LocationOnOutlinedIcon />, label: 'Busiest site', value: busiestSite?.site, meta: busiestSite ? `${busiestSite.onSite} inside` : 'No live sessions' },
                  { icon: <ConstructionOutlinedIcon />, label: 'Leading vendor today', value: topVendor?.vendor, meta: topVendor ? `${topVendor.count} sessions` : 'No vendor attendance' },
                  { icon: <EngineeringOutlinedIcon />, label: 'Top designation', value: topTrade?.trade, meta: topTrade ? `${topTrade.count} attendance records` : 'No designation activity' },
                ].map((item) => (
                  <Stack key={item.label} direction="row" spacing={1.5} alignItems="flex-start">
                    <Box sx={{ color: amber, mt: 0.2, '& svg': { fontSize: 19 } }}>{item.icon}</Box>
                    <Box minWidth={0}>
                      <Typography sx={{ fontSize: 10.5, color: alpha('#FFFFFF', 0.55) }}>{item.label}</Typography>
                      <Typography noWrap sx={{ mt: 0.25, fontSize: 14, fontWeight: 720 }}>{item.value ?? '—'}</Typography>
                      <Typography sx={{ fontSize: 10.5, color: alpha('#FFFFFF', 0.48) }}>{item.meta}</Typography>
                    </Box>
                  </Stack>
                ))}
              </Stack>
            </Box>
            <Box sx={{ borderTop: `1px solid ${alpha('#FFFFFF', 0.14)}`, p: 1.5 }}>
              <Stack direction="row" spacing={1}>
                <Tooltip title="Workers">
                  <IconButton onClick={() => router.push('/workers')} sx={{ color: '#FFFFFF', borderRadius: 1 }}>
                    <BadgeOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Sites">
                  <IconButton onClick={() => router.push('/sites')} sx={{ color: '#FFFFFF', borderRadius: 1 }}>
                    <LocationOnOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Reports">
                  <IconButton onClick={() => router.push('/reports')} sx={{ color: '#FFFFFF', borderRadius: 1 }}>
                    <TrendingUpOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Attendance">
                  <IconButton onClick={() => router.push('/attendance')} sx={{ color: '#FFFFFF', borderRadius: 1 }}>
                    <GroupsOutlinedIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            </Box>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
