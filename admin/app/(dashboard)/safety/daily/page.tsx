'use client';

import * as React from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '@/components/PageHeader';
import { FilterBar } from '@/components/ui/FilterBar';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { useToast } from '@/components/ui/Toast';
import type { Site } from '@/lib/types';
import { HiddenPageGate } from '@/components/HiddenPageGate';

type MetricKind = 'AUTOMATED' | 'MANUAL';

interface DailyItem {
  metric: string;
  label: string;
  kind: MetricKind;
  group: string;
  value: number | null;
  comment: string | null;
  entryId: string | null;
  updatedAt: string | null;
}
interface DailyBoard {
  date: string;
  siteId: string;
  editable: boolean;
  items: DailyItem[];
}
interface HistoryRow {
  date: string;
  value: number | null;
  comment: string | null;
  /** False for a day with nothing entered — the API returns the whole window. */
  recorded: boolean;
}
interface HistoryResult {
  metric: string;
  label: string;
  kind: MetricKind;
  rows: HistoryRow[];
}

const today = () => new Date().toISOString().slice(0, 10);

/** Local edits, keyed by metric. Absent means "untouched". */
type Draft = Record<string, { value?: string; comment?: string }>;

export default function DailyTaskPage() {
  return (
    <HiddenPageGate>
      <DailyTaskForm />
    </HiddenPageGate>
  );
}

function DailyTaskForm() {
  const [siteId, setSiteId] = React.useState('');
  const [date, setDate] = React.useState(today);
  const [draft, setDraft] = React.useState<Draft>({});
  const [historyOf, setHistoryOf] = React.useState<DailyItem | null>(null);
  const [confirmClear, setConfirmClear] = React.useState<DailyItem | null>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  // The form writes to one site, so it opens on the first one rather than on an
  // "All sites" aggregate that cannot be saved.
  React.useEffect(() => {
    if (!siteId && sites.data?.length) setSiteId(sites.data[0].id);
  }, [sites.data, siteId]);

  const board = useQuery({
    queryKey: ['safety-daily', date, siteId],
    queryFn: () => api.get<DailyBoard>(`/safety/daily?date=${date}&siteId=${siteId}`),
    enabled: Boolean(siteId),
  });

  // A new day or site is a different set of figures; stale keystrokes must not
  // follow the user across.
  React.useEffect(() => {
    setDraft({});
  }, [date, siteId]);

  const dirty = Object.keys(draft).length > 0;

  const save = useMutation({
    mutationFn: async () => {
      const items = (board.data?.items ?? [])
        .filter((it) => it.kind !== 'AUTOMATED' && draft[it.metric] !== undefined)
        .map((it) => {
          const d = draft[it.metric] ?? {};
          const raw = d.value ?? (it.value == null ? '' : String(it.value));
          const comment = d.comment ?? it.comment ?? '';
          return {
            metric: it.metric,
            // Blank clears the number back to "not filled in" rather than zero.
            value: raw.trim() === '' ? null : Number(raw),
            comment: comment.trim() === '' ? null : comment,
          };
        });
      return api.put<DailyBoard>('/safety/daily', { siteId, date, items });
    },
    onSuccess: () => {
      setDraft({});
      qc.invalidateQueries({ queryKey: ['safety-daily'] });
      qc.invalidateQueries({ queryKey: ['safety-stats'] });
      toast.success('Saved.');
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not save the figures.')),
  });

  const clearOne = useMutation({
    mutationFn: (metric: string) =>
      api.del(`/safety/metric?siteId=${siteId}&date=${date}&metric=${metric}`),
    onSuccess: () => {
      setConfirmClear(null);
      qc.invalidateQueries({ queryKey: ['safety-daily'] });
      qc.invalidateQueries({ queryKey: ['safety-stats'] });
      toast.success('Cleared.');
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not clear that item.')),
  });

  /**
   * Only the items somebody actually types.
   *
   * Manpower and safe man-hours are computed from attendance, so a field for
   * them would either be dead or would invite an edit that gets thrown away.
   * They are read on the statistics board instead.
   */
  const groups = React.useMemo(() => {
    const out = new Map<string, DailyItem[]>();
    for (const it of board.data?.items ?? []) {
      if (it.kind === 'AUTOMATED') continue;
      if (!out.has(it.group)) out.set(it.group, []);
      out.get(it.group)!.push(it);
    }
    return [...out.entries()];
  }, [board.data]);

  const fieldValue = (it: DailyItem) =>
    draft[it.metric]?.value ?? (it.value == null ? '' : String(it.value));
  const commentValue = (it: DailyItem) => draft[it.metric]?.comment ?? it.comment ?? '';

  const setField = (metric: string, patch: { value?: string; comment?: string }) =>
    setDraft((d) => ({ ...d, [metric]: { ...d[metric], ...patch } }));

  return (
    <Box>
      <PageHeader
        title="Daily task"
        subtitle="The day's safety figures. Three are taken from attendance; the rest are yours to enter."
        action={
          <Button
            variant="contained"
            startIcon={save.isPending ? <CircularProgress size={16} /> : <SaveOutlinedIcon />}
            disabled={!dirty || save.isPending || !siteId}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        }
      />

      <FilterBar>
        <TextField
          select
          size="small"
          label="Project / site"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          sx={{ minWidth: 220 }}
        >
          {(sites.data ?? []).map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          type="date"
          size="small"
          label="Date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          InputLabelProps={{ shrink: true }}
          inputProps={{ max: today() }}
        />
      </FilterBar>

      {dirty && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Unsaved changes. Nothing is recorded until you press Save.
        </Alert>
      )}

      {board.isLoading && !board.data ? (
        <Box sx={{ display: 'grid', placeItems: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : board.isError ? (
        <Alert severity="error">{apiErrorMessage(board.error, 'Could not load the day.')}</Alert>
      ) : !siteId ? (
        <EmptyState title="No sites yet" description="Add a site before recording safety figures." />
      ) : (
        <Stack spacing={2}>
          {groups.map(([group, items]) => (
            <Card key={group}>
              <CardContent>
                <Typography variant="subtitle1" sx={{ mb: 1.5 }}>
                  {group}
                </Typography>
                <Divider sx={{ mb: 1 }} />
                <Stack divider={<Divider flexItem />} spacing={0}>
                  {items.map((it) => (
                    <Stack
                      key={it.metric}
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={1.5}
                      alignItems={{ md: 'center' }}
                      sx={{ py: 1.25 }}
                    >
                      <Box sx={{ minWidth: 0, flex: '1 1 240px' }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                          {it.label}
                        </Typography>
                      </Box>

                      <TextField
                        size="small"
                        type="number"
                        label="Count"
                        value={fieldValue(it)}
                        onChange={(e) => setField(it.metric, { value: e.target.value })}
                        inputProps={{ min: 0 }}
                        sx={{ width: 150 }}
                      />

                      <TextField
                        size="small"
                        label="Comment (optional)"
                        value={commentValue(it)}
                        onChange={(e) => setField(it.metric, { comment: e.target.value })}
                        sx={{ flex: '2 1 260px' }}
                      />

                      <Stack direction="row" spacing={0.5} sx={{ flexShrink: 0 }}>
                        <Tooltip title="View all dates">
                          <IconButton size="small" onClick={() => setHistoryOf(it)}>
                            <HistoryOutlinedIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip
                          title={
                            it.entryId ? 'Clear this entry' : 'Nothing recorded yet'
                          }
                        >
                          <span>
                            <IconButton
                              size="small"
                              disabled={!it.entryId}
                              onClick={() => setConfirmClear(it)}
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Stack>
                    </Stack>
                  ))}
                </Stack>
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}

      <HistoryDialog
        item={historyOf}
        siteId={siteId}
        onClose={() => setHistoryOf(null)}
      />

      <ConfirmDialog
        open={Boolean(confirmClear)}
        title="Clear this entry?"
        message={`"${confirmClear?.label}" goes back to not filled in for ${date} — which is not the same as recording zero.`}
        confirmLabel="Clear"
        danger
        busy={clearOne.isPending}
        onClose={() => setConfirmClear(null)}
        onConfirm={() => confirmClear && clearOne.mutate(confirmClear.metric)}
      />
    </Box>
  );
}

/** One metric across every date it was recorded on. */
function HistoryDialog({
  item,
  siteId,
  onClose,
}: {
  item: DailyItem | null;
  siteId: string;
  onClose: () => void;
}) {
  const history = useQuery({
    queryKey: ['safety-history', item?.metric, siteId],
    queryFn: () =>
      api.get<HistoryResult>(`/safety/history?metric=${item!.metric}&siteId=${siteId}`),
    enabled: Boolean(item),
  });

  // The window comes back complete, gaps included; a list of blanks is noise.
  const recordedRows = React.useMemo(
    () => (history.data?.rows ?? []).filter((r) => r.recorded),
    [history.data],
  );

  return (
    <Dialog open={Boolean(item)} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{item?.label} — all dates</DialogTitle>
      <DialogContent>
        {history.isLoading ? (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 4 }}>
            <CircularProgress size={24} />
          </Box>
        ) : history.isError ? (
          <Alert severity="error">
            {apiErrorMessage(history.error, 'Could not load the history.')}
          </Alert>
        ) : recordedRows.length === 0 ? (
          <EmptyState
            compact
            title="Nothing recorded yet"
            description="This item has no entries in the last 30 days."
          />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Date</TableCell>
                <TableCell align="right">Value</TableCell>
                <TableCell>Comment</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recordedRows.map((r) => (
                <TableRow key={r.date} hover>
                  <TableCell>{r.date}</TableCell>
                  <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                    {r.value ?? '—'}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{r.comment ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
    </Dialog>
  );
}
