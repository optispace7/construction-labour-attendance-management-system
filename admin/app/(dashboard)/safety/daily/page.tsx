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
import AddIcon from '@mui/icons-material/Add';
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
interface WasteType {
  id: string;
  name: string;
  sortOrder: number;
  /** False for a retired type: kept for its history, gone from the dropdown. */
  isActive: boolean;
}
interface WasteRow {
  wasteTypeId: string;
  value: number;
}
interface DailyBoard {
  date: string;
  siteId: string;
  editable: boolean;
  items: DailyItem[];
  waste: { types: WasteType[]; rows: WasteRow[] };
}

/** The metric whose figure is the total of the waste breakdown, not typed. */
const WASTE_METRIC = 'WASTE_DISPOSAL';

/** One line of the breakdown as the form holds it, while it is being edited. */
interface WasteLine {
  /** Empty on a line just added, until a type is picked. */
  wasteTypeId: string;
  value: string;
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
  /** Null while the breakdown is still the server's; an array once edited. */
  const [wasteDraft, setWasteDraft] = React.useState<WasteLine[] | null>(null);
  const [managingTypes, setManagingTypes] = React.useState(false);
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
    setWasteDraft(null);
  }, [date, siteId]);

  const wasteTypes = React.useMemo(() => board.data?.waste.types ?? [], [board.data]);
  const serverWaste = React.useMemo<WasteLine[]>(
    () => (board.data?.waste.rows ?? []).map((r) => ({ wasteTypeId: r.wasteTypeId, value: String(r.value) })),
    [board.data],
  );
  const wasteLines = wasteDraft ?? serverWaste;

  const dirty = Object.keys(draft).length > 0 || wasteDraft !== null;

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

      /**
       * The breakdown, only when it has been touched.
       *
       * A line taken off the form has to be sent as null rather than simply
       * left out — the API replaces what it is given, and silence about a type
       * means "leave it alone", not "delete it".
       */
      let waste: { wasteTypeId: string; value: number | null }[] | undefined;
      if (wasteDraft) {
        const kept = wasteLines.filter((l) => l.wasteTypeId);
        const present = new Set(kept.map((l) => l.wasteTypeId));
        waste = [
          ...kept.map((l) => ({
            wasteTypeId: l.wasteTypeId,
            value: l.value.trim() === '' ? null : Number(l.value),
          })),
          ...serverWaste
            .filter((l) => !present.has(l.wasteTypeId))
            .map((l) => ({ wasteTypeId: l.wasteTypeId, value: null })),
        ];
      }

      return api.put<DailyBoard>('/safety/daily', { siteId, date, items, waste });
    },
    onSuccess: () => {
      setDraft({});
      setWasteDraft(null);
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

  /**
   * What the waste row will read once saved: the breakdown's own total, so the
   * headline moves with the lines as they are typed rather than after a save.
   * Null when nothing has been said about waste at all, which is a blank and
   * not a zero.
   */
  const wasteTotal = React.useMemo(() => {
    const filled = wasteLines.filter((l) => l.wasteTypeId && l.value.trim() !== '');
    if (filled.length === 0) return null;
    return filled.reduce((sum, l) => sum + (Number(l.value) || 0), 0);
  }, [wasteLines]);

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

                      {/* Waste is the total of the breakdown below, so it is
                          shown rather than typed — a second place to enter it
                          is a second answer to the same question. */}
                      <TextField
                        size="small"
                        type={it.metric === WASTE_METRIC ? 'text' : 'number'}
                        label={it.metric === WASTE_METRIC ? 'Total' : 'Count'}
                        value={
                          it.metric === WASTE_METRIC
                            ? wasteTotal == null
                              ? '—'
                              : String(wasteTotal)
                            : fieldValue(it)
                        }
                        onChange={(e) => setField(it.metric, { value: e.target.value })}
                        disabled={it.metric === WASTE_METRIC}
                        helperText={it.metric === WASTE_METRIC ? 'From the breakdown' : undefined}
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

          <WasteCard
            types={wasteTypes}
            lines={wasteLines}
            total={wasteTotal}
            onChange={setWasteDraft}
            onManage={() => setManagingTypes(true)}
          />
        </Stack>
      )}

      <HistoryDialog
        item={historyOf}
        siteId={siteId}
        onClose={() => setHistoryOf(null)}
      />

      <ManageWasteTypesDialog
        open={managingTypes}
        types={wasteTypes}
        onClose={() => setManagingTypes(false)}
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

/**
 * The waste breakdown: what went out today, split by type.
 *
 * A card of its own rather than a row in Compliance, because it is a small
 * table and the sheet's other items are single figures. The metric above shows
 * the total; this is where the number actually comes from.
 */
function WasteCard({
  types,
  lines,
  total,
  onChange,
  onManage,
}: {
  types: WasteType[];
  lines: WasteLine[];
  total: number | null;
  onChange: (next: WasteLine[]) => void;
  onManage: () => void;
}) {
  const byId = React.useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const used = new Set(lines.map((l) => l.wasteTypeId).filter(Boolean));

  /**
   * A type already on the form is off the dropdown, so the same stream cannot
   * be entered twice and end up as two figures nobody can add up. A retired
   * type still appears on the line already holding it, so its figure stays
   * readable and editable — it just cannot be chosen for a new line.
   */
  const choicesFor = (line: WasteLine) =>
    types.filter((t) => t.id === line.wasteTypeId || (t.isActive && !used.has(t.id)));

  const setLine = (i: number, patch: Partial<WasteLine>) =>
    onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const spare = types.filter((t) => t.isActive && !used.has(t.id));

  return (
    <Card>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }}>
          <Typography variant="subtitle1">Waste disposal</Typography>
          <Box sx={{ flex: 1 }} />
          <Typography variant="body2" color="text.secondary">
            Total {total ?? '—'}
          </Typography>
          <Button size="small" onClick={onManage}>
            Manage types
          </Button>
        </Stack>
        <Divider sx={{ mb: 1 }} />

        {lines.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 1.5 }}>
            Nothing recorded for today. Add a line for each kind of waste that went out.
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />} spacing={0}>
            {lines.map((line, i) => (
              <Stack
                key={`${line.wasteTypeId}-${i}`}
                direction={{ xs: 'column', md: 'row' }}
                spacing={1.5}
                alignItems={{ md: 'center' }}
                sx={{ py: 1.25 }}
              >
                <TextField
                  select
                  size="small"
                  label="Waste type"
                  value={line.wasteTypeId}
                  onChange={(e) => setLine(i, { wasteTypeId: e.target.value })}
                  sx={{ flex: '1 1 260px' }}
                >
                  {choicesFor(line).map((t) => (
                    <MenuItem key={t.id} value={t.id}>
                      {t.name}
                      {t.isActive ? '' : ' (retired)'}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField
                  size="small"
                  type="number"
                  label="Count"
                  value={line.value}
                  onChange={(e) => setLine(i, { value: e.target.value })}
                  inputProps={{ min: 0 }}
                  sx={{ width: 150 }}
                />
                <Tooltip title="Remove this line">
                  <IconButton
                    size="small"
                    onClick={() => onChange(lines.filter((_, j) => j !== i))}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                {!byId.get(line.wasteTypeId)?.isActive && line.wasteTypeId && (
                  <Typography variant="caption" color="text.secondary">
                    Retired type
                  </Typography>
                )}
              </Stack>
            ))}
          </Stack>
        )}

        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button
            size="small"
            startIcon={<AddIcon />}
            disabled={spare.length === 0}
            onClick={() => onChange([...lines, { wasteTypeId: spare[0]?.id ?? '', value: '' }])}
          >
            Add waste type
          </Button>
          {spare.length === 0 && types.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
              Every type is already on the sheet.
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * Add, rename and remove the waste types the dropdown offers.
 *
 * Removing one that has figures behind it retires it instead of deleting it:
 * it leaves the dropdown, and the months that counted it keep their numbers.
 * The API decides which of the two happened and says so.
 */
function ManageWasteTypesDialog({
  open,
  types,
  onClose,
}: {
  open: boolean;
  types: WasteType[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = React.useState('');
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  const [confirmRemove, setConfirmRemove] = React.useState<WasteType | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ['safety-daily'] });

  const create = useMutation({
    mutationFn: (name: string) => api.post('/safety/waste-types', { name }),
    onSuccess: () => {
      setAdding('');
      refresh();
      toast.success('Waste type added.');
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not add that type.')),
  });

  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/safety/waste-types/${id}`, { name }),
    onSuccess: () => {
      setEditingId(null);
      refresh();
      toast.success('Waste type updated.');
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not rename that type.')),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api.del<{ deleted: boolean; retired: boolean; entriesKept: number }>(
        `/safety/waste-types/${id}`,
      ),
    onSuccess: (res) => {
      setConfirmRemove(null);
      refresh();
      toast.success(
        res.retired
          ? `Retired — ${res.entriesKept} recorded ${res.entriesKept === 1 ? 'entry keeps' : 'entries keep'} their figures.`
          : 'Waste type removed.',
      );
    },
    onError: (e) => toast.error(apiErrorMessage(e, 'Could not remove that type.')),
  });

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
        <DialogTitle>Waste types</DialogTitle>
        <DialogContent>
          <Stack direction="row" spacing={1} sx={{ mt: 1, mb: 2 }}>
            <TextField
              size="small"
              fullWidth
              label="Add a waste type"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && adding.trim()) create.mutate(adding.trim());
              }}
            />
            <Button
              variant="contained"
              disabled={!adding.trim() || create.isPending}
              onClick={() => create.mutate(adding.trim())}
            >
              Add
            </Button>
          </Stack>

          <Stack divider={<Divider flexItem />} spacing={0}>
            {types.map((t) => (
              <Stack key={t.id} direction="row" spacing={1} alignItems="center" sx={{ py: 1 }}>
                {editingId === t.id ? (
                  <>
                    <TextField
                      size="small"
                      fullWidth
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && editingName.trim()) {
                          rename.mutate({ id: t.id, name: editingName.trim() });
                        }
                      }}
                    />
                    <Button
                      size="small"
                      disabled={!editingName.trim() || rename.isPending}
                      onClick={() => rename.mutate({ id: t.id, name: editingName.trim() })}
                    >
                      Save
                    </Button>
                    <Button size="small" color="inherit" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {t.name}
                      {t.isActive ? '' : ' · retired'}
                    </Typography>
                    <Button
                      size="small"
                      onClick={() => {
                        setEditingId(t.id);
                        setEditingName(t.name);
                      }}
                    >
                      {t.isActive ? 'Rename' : 'Restore'}
                    </Button>
                    {t.isActive && (
                      <Tooltip title="Remove from the dropdown">
                        <IconButton size="small" onClick={() => setConfirmRemove(t)}>
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </>
                )}
              </Stack>
            ))}
          </Stack>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(confirmRemove)}
        title="Remove this waste type?"
        message={`"${confirmRemove?.name}" comes off the dropdown. Any day it has already been recorded against keeps its figure — the type is retired rather than deleted once it has been used.`}
        confirmLabel="Remove"
        danger
        busy={remove.isPending}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && remove.mutate(confirmRemove.id)}
      />
    </>
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
