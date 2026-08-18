'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
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
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { StatusBadge, BadgeTone } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { formatFullDate } from '@/lib/format';
import { useMe } from '@/lib/me';
import { CompanyDocument, Site } from '@/lib/types';

/** Matches the server's cap; checked here so a big file fails before upload. */
const MAX_BYTES = 8 * 1024 * 1024;

/** The reminder lead time a new document starts with. */
const DEFAULT_REMIND_DAYS = 10;

const MAX_REMIND_DAYS = 365;

/** The editable half of a document — the same fields whether new or stored. */
interface DocumentForm {
  siteId: string;
  name: string;
  validUntil: string; // YYYY-MM-DD, '' = never expires
  remindDaysBefore: string; // kept as text so the field can be cleared
}

/** A picked-but-not-yet-uploaded PDF. */
interface Draft extends DocumentForm {
  fileName: string;
  dataBase64: string;
  sizeBytes: number;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "PF-registration.pdf" → "PF-registration". The client renames it from there. */
function nameFromFile(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '').trim() || fileName;
}

/**
 * How the validity reads at a glance. The countdown comes from the server,
 * which measures it in the company's own timezone — a browser somewhere else
 * must not be what decides whether a licence lapses today or tomorrow.
 */
function validityStatus(doc: CompanyDocument): { label: string; tone: BadgeTone } {
  const days = doc.daysUntilExpiry;
  if (days === null) return { label: 'No expiry', tone: 'neutral' };
  if (days < 0) return { label: `Expired ${plural(Math.abs(days), 'day')} ago`, tone: 'error' };
  if (days === 0) return { label: 'Expires today', tone: 'error' };
  if (days === 1) return { label: 'Expires tomorrow', tone: 'warning' };
  if (days <= doc.remindDaysBefore) return { label: `${days} days left`, tone: 'warning' };
  return { label: `${days} days left`, tone: 'success' };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** The day the reminder would go out, for the dialog's helper line. */
function remindOn(validUntil: string, days: number): string | null {
  if (!validUntil || !Number.isFinite(days)) return null;
  const d = new Date(`${validUntil}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() - days);
  return formatFullDate(d);
}

/**
 * Site paperwork: upload a PDF against a site, name it, give it a validity
 * date, and say how long before that date the reminder mail should arrive.
 *
 * A licence is granted for a particular project, so each document is held
 * against the site it covers rather than in one company-wide pile — which is
 * also what makes the expiry alert useful, since it can name the site left
 * uncovered rather than only the piece of paper.
 */
export function CompanyDocuments() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const fileInput = React.useRef<HTMLInputElement>(null);

  // Filing, renaming and deleting are SETTINGS_MANAGE, which the Safety Officer
  // does not hold — they read these and open them. Hidden rather than
  // shown-and-refused; the API is what actually enforces it.
  const canManage = me.role === 'SUPER_ADMIN' || me.role === 'SITE_ADMIN';

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [editing, setEditing] = React.useState<CompanyDocument | null>(null);
  const [form, setForm] = React.useState<DocumentForm | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = React.useState<CompanyDocument | null>(null);
  const [siteFilter, setSiteFilter] = React.useState('all');

  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });

  const documents = useQuery({
    queryKey: ['company-documents', siteFilter],
    queryFn: () =>
      api.get<CompanyDocument[]>(
        siteFilter === 'all' ? '/company-documents' : `/company-documents?siteId=${siteFilter}`,
      ),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ['company-documents'] });
  const closeDialog = () => {
    setDraft(null);
    setEditing(null);
    setForm(null);
    setFormError(null);
  };

  /** The site to open the upload dialog on: whichever one is being viewed. */
  const defaultSiteId = () => {
    if (siteFilter !== 'all') return siteFilter;
    return sites.data?.length === 1 ? sites.data[0].id : '';
  };

  const body = (f: DocumentForm) => ({
    siteId: f.siteId,
    name: f.name.trim(),
    validUntil: f.validUntil || null,
    remindDaysBefore: Number(f.remindDaysBefore || DEFAULT_REMIND_DAYS),
  });

  const save = useMutation({
    mutationFn: () => {
      if (!form) throw new Error('Nothing to save');
      if (editing) return api.patch(`/company-documents/${editing.id}`, body(form));
      if (!draft) throw new Error('No file selected');
      return api.post('/company-documents', {
        ...body(form),
        fileName: draft.fileName,
        mimeType: 'application/pdf',
        dataBase64: draft.dataBase64,
      });
    },
    onSuccess: () => {
      const wasEdit = !!editing;
      refresh();
      closeDialog();
      toast.success(wasEdit ? 'Document updated' : 'Document uploaded');
    },
    onError: (e) => setFormError(apiErrorMessage(e, 'Failed to save the document')),
  });

  const remove = useMutation({
    mutationFn: (doc: CompanyDocument) => api.del(`/company-documents/${doc.id}`),
    onSuccess: (_res, doc) => {
      refresh();
      setPendingDelete(null);
      toast.success(`"${doc.name}" deleted`);
    },
    onError: (e) => {
      setPendingDelete(null);
      toast.error(apiErrorMessage(e, 'Failed to delete the document'));
    },
  });

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so re-picking the same file fires onChange again
    if (!file) return;
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      toast.error('Only PDF documents can be uploaded');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(`That file is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_BYTES)}`);
      return;
    }
    try {
      const dataBase64 = await readAsBase64(file);
      // The file's own name is the opening suggestion; the dialog lets them
      // change it before anything is stored.
      const seeded = {
        siteId: defaultSiteId(),
        name: nameFromFile(file.name),
        validUntil: '',
        remindDaysBefore: String(DEFAULT_REMIND_DAYS),
      };
      setDraft({ ...seeded, fileName: file.name, dataBase64, sizeBytes: file.size });
      setEditing(null);
      setForm(seeded);
      setFormError(null);
    } catch {
      toast.error('Could not read that file');
    }
  };

  const openEdit = (doc: CompanyDocument) => {
    setDraft(null);
    setEditing(doc);
    setForm({
      siteId: doc.siteId,
      name: doc.name,
      validUntil: doc.validUntil ?? '',
      remindDaysBefore: String(doc.remindDaysBefore),
    });
    setFormError(null);
  };

  const uploadButton = canManage ? (
    <Button
      variant="outlined"
      size="small"
      startIcon={<FileUploadOutlinedIcon />}
      onClick={() => fileInput.current?.click()}
    >
      Upload PDF
    </Button>
  ) : null;

  const rows = documents.data ?? [];
  const days = Number(form?.remindDaysBefore ?? '');
  const daysInvalid =
    form !== null &&
    form.validUntil !== '' &&
    (!Number.isInteger(days) || days < 0 || days > MAX_REMIND_DAYS);
  const reminderDate = form ? remindOn(form.validUntil, days) : null;
  // Showing one site's documents already answers "whose is this", so the column
  // only earns its width when everything is on screen at once.
  const showSiteColumn = siteFilter === 'all';

  const siteFilterControl = (
    <TextField
      select
      size="small"
      label="Site"
      value={siteFilter}
      onChange={(e) => setSiteFilter(e.target.value)}
      sx={{ minWidth: 200 }}
    >
      <MenuItem value="all">All sites</MenuItem>
      {(sites.data ?? []).map((s) => (
        <MenuItem key={s.id} value={s.id}>
          {s.name}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <Card>
      {/* No title inside the card: the page above already says "Documents", and
          a heading repeated twice reads as a mistake. The card carries only the
          controls that act on the list. */}
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ px: 2.5, py: 2, borderBottom: '1px solid', borderColor: 'divider' }}
      >
        <DescriptionOutlinedIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
        <Typography variant="body2" color="text.secondary">
          {canManage
            ? 'Super Admins are emailed before a document expires'
            : 'Read-only — an Admin files and renews these'}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {siteFilterControl}
        {uploadButton}
      </Stack>
      {canManage && (
        <input
          ref={fileInput}
          hidden
          type="file"
          accept="application/pdf,.pdf"
          onChange={(e) => void onFile(e)}
        />
      )}

      {rows.length === 0 && !documents.isLoading ? (
        <Box sx={{ px: 2.5, py: 4, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            {siteFilter !== 'all'
              ? 'Nothing filed against this site yet.'
              : canManage
                ? 'No documents yet. Upload a PDF, choose the site it covers and give it a validity date — a reminder is emailed to the Super Admins before it runs out.'
                : 'No documents have been filed yet.'}
          </Typography>
          {uploadButton && <Box sx={{ mt: 2 }}>{uploadButton}</Box>}
        </Box>
      ) : (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="medium" sx={{ minWidth: showSiteColumn ? 820 : 720 }}>
            <TableHead>
              <TableRow>
                <TableCell>Document</TableCell>
                {showSiteColumn && <TableCell>Site</TableCell>}
                <TableCell>Valid until</TableCell>
                <TableCell>Reminder</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((doc) => {
                const status = validityStatus(doc);
                return (
                  <TableRow key={doc.id}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {doc.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {doc.fileName} · {fmtBytes(doc.sizeBytes)}
                      </Typography>
                    </TableCell>
                    {showSiteColumn && (
                      <TableCell>
                        <Typography variant="body2">{doc.siteName ?? '—'}</Typography>
                      </TableCell>
                    )}
                    <TableCell>
                      <Stack spacing={0.5} alignItems="flex-start">
                        <Typography variant="body2">
                          {doc.validUntil ? formatFullDate(doc.validUntil) : '—'}
                        </Typography>
                        <StatusBadge label={status.label} tone={status.tone} />
                      </Stack>
                    </TableCell>
                    <TableCell>
                      {doc.validUntil ? (
                        <>
                          <Typography variant="body2">
                            {plural(doc.remindDaysBefore, 'day')} before
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {doc.reminderSentFor === doc.validUntil
                              ? 'Reminder sent'
                              : `Emails on ${formatFullDate(doc.remindOn)}`}
                          </Typography>
                        </>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        <Tooltip title="Open document">
                          <IconButton
                            size="small"
                            component="a"
                            href={`/api/company-documents/${doc.id}`}
                            target="_blank"
                            rel="noopener"
                          >
                            <OpenInNewIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        {canManage && (
                          <>
                            <Tooltip title="Edit name, validity or reminder">
                              <IconButton size="small" onClick={() => openEdit(doc)}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Delete document">
                              <IconButton size="small" onClick={() => setPendingDelete(doc)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      )}

      <Dialog open={!!form} onClose={save.isPending ? undefined : closeDialog} fullWidth maxWidth="sm">
        <DialogTitle>{editing ? 'Edit document' : 'Add document'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            {formError && <Alert severity="error">{formError}</Alert>}
            {(draft ?? editing) && (
              <Alert severity="info" icon={<DescriptionOutlinedIcon fontSize="inherit" />}>
                {(draft ?? editing)!.fileName} · {fmtBytes((draft ?? editing)!.sizeBytes)}
              </Alert>
            )}
            {/* Which site this covers, first: it decides who the expiry alert
                names and where the document is filed. */}
            <TextField
              select
              label="Site"
              fullWidth
              required
              value={form?.siteId ?? ''}
              onChange={(e) => setForm((f) => (f ? { ...f, siteId: e.target.value } : f))}
              helperText="The site this document covers"
            >
              {(sites.data ?? []).map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Document name"
              fullWidth
              autoFocus
              value={form?.name ?? ''}
              onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
              helperText={
                editing
                  ? 'The name this document is listed under.'
                  : 'Taken from the file name — change it to whatever you call this document.'
              }
            />
            <TextField
              label="Valid until"
              type="date"
              fullWidth
              InputLabelProps={{ shrink: true }}
              value={form?.validUntil ?? ''}
              onChange={(e) => setForm((f) => (f ? { ...f, validUntil: e.target.value } : f))}
              helperText="Leave blank if this document does not expire."
            />
            <TextField
              label="Remind me before it expires"
              type="number"
              fullWidth
              disabled={!form?.validUntil}
              value={form?.remindDaysBefore ?? ''}
              onChange={(e) =>
                setForm((f) => (f ? { ...f, remindDaysBefore: e.target.value } : f))
              }
              inputProps={{ min: 0, max: MAX_REMIND_DAYS }}
              InputProps={{
                endAdornment: <InputAdornment position="end">days before</InputAdornment>,
              }}
              error={daysInvalid}
              helperText={
                !form?.validUntil
                  ? 'Set a validity date to switch reminders on.'
                  : daysInvalid
                    ? `Enter a whole number of days between 0 and ${MAX_REMIND_DAYS}.`
                    : reminderDate
                      ? `Super Admins are emailed on ${reminderDate}, and again the day it expires.`
                      : ' '
              }
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button color="inherit" onClick={closeDialog} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={save.isPending || !form?.siteId || !form?.name.trim() || daysInvalid}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : editing ? 'Save' : 'Add document'}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={!!pendingDelete}
        title="Delete document?"
        message={`Delete "${pendingDelete?.name}"? The file is removed and its expiry reminder stops.`}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
        onClose={() => setPendingDelete(null)}
      />
    </Card>
  );
}
