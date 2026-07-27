'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { api } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, Column } from '@/components/ui/DataTable';
import { StatusBadge, statusTone } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { ManualAttendanceRequest } from '@/lib/types';

const EMPTY_COPY: Record<string, { title: string; description: string }> = {
  PENDING: {
    title: 'Nothing waiting',
    description:
      'When a watchman types someone in instead of scanning their badge, it appears here until you accept or decline it.',
  },
  APPROVED: {
    title: 'No accepted entries',
    description: 'Manual entries you accept are listed here with who accepted them.',
  },
  REJECTED: {
    title: 'No declined entries',
    description: 'Manual entries you decline are kept here — nothing is ever deleted.',
  },
};

type Decision = {
  request: ManualAttendanceRequest;
  action: 'approve' | 'reject';
};

/** How long this person has been off the register. */
function waitedFor(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Hand-typed punches waiting on a decision.
 *
 * A badge scan is evidence that a card was at the gate; a typed worker code is
 * one person's word. So these do not become attendance until someone accepts
 * them — which also means everyone on the Pending tab is missing from "on site
 * now" and from the SOS headcount right now. The page says so at the top,
 * because that is the fact an admin needs before they decide how fast to work
 * through the list.
 */
export default function ManualEntriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = React.useState('PENDING');
  const [decision, setDecision] = React.useState<Decision | null>(null);
  const [notes, setNotes] = React.useState('');

  const list = useQuery({
    queryKey: ['manual-approvals', status],
    queryFn: () => api.get<ManualAttendanceRequest[]>(`/manual-approvals?status=${status}`),
  });

  const decide = useMutation({
    mutationFn: ({ id, action, reviewNotes }: { id: string; action: string; reviewNotes: string }) =>
      api.post(`/manual-approvals/${id}/${action}`, reviewNotes ? { reviewNotes } : {}),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['manual-approvals'] });
      // Accepting writes a session, so anything counting people is now stale.
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(
        vars.action === 'approve'
          ? 'Accepted — the attendance is now recorded'
          : 'Declined — attendance left unchanged',
      );
      setDecision(null);
      setNotes('');
    },
    onError: (err: unknown) => {
      // The worker may have turned up with their badge since. The API says
      // exactly what happened, and that sentence is what the admin needs.
      const detail =
        (err as { detail?: string; message?: string })?.detail ??
        (err as { message?: string })?.message;
      toast.error(detail || 'Could not save that decision');
    },
  });

  const columns: Column<ManualAttendanceRequest>[] = [
    {
      key: 'worker',
      label: 'Worker',
      render: (r) =>
        r.worker ? (
          <>
            <Typography variant="body2">{r.worker.fullName}</Typography>
            <Typography variant="caption" color="text.secondary">
              {[r.worker.workerCode, r.worker.designation?.name, r.worker.vendor?.name]
                .filter(Boolean)
                .join(' · ')}
            </Typography>
          </>
        ) : (
          '—'
        ),
    },
    {
      key: 'tapType',
      label: 'Entry',
      render: (r) => (
        <StatusBadge label={r.tapType} tone={r.tapType === 'LOGIN' ? 'success' : 'warning'} />
      ),
    },
    {
      key: 'recordedAt',
      label: 'Recorded at',
      render: (r) => (
        <>
          <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
            {new Date(r.recordedAt).toLocaleString()}
          </Typography>
          {r.status === 'PENDING' && (
            <Typography variant="caption" color="warning.main">
              waiting {waitedFor(r.recordedAt)}
            </Typography>
          )}
        </>
      ),
    },
    { key: 'site', label: 'Site', render: (r) => r.site?.name ?? '—' },
    {
      key: 'reason',
      label: 'Reason given',
      render: (r) => (
        <Typography variant="body2" color={r.reason ? 'text.primary' : 'text.secondary'}>
          {r.reason || 'None'}
        </Typography>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => (
        <>
          <StatusBadge label={r.status} tone={statusTone(r.status)} />
          {r.reviewedByName && (
            <Tooltip arrow title={r.reviewNotes ? `Note: ${r.reviewNotes}` : ''}>
              <Typography variant="caption" display="block" color="text.secondary">
                by {r.reviewedByName}
              </Typography>
            </Tooltip>
          )}
        </>
      ),
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      render: (r) =>
        r.status === 'PENDING' ? (
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              size="small"
              color="success"
              variant="contained"
              startIcon={<CheckIcon />}
              disabled={decide.isPending}
              onClick={() => {
                setNotes('');
                setDecision({ request: r, action: 'approve' });
              }}
            >
              Accept
            </Button>
            <Button
              size="small"
              color="error"
              variant="outlined"
              startIcon={<CloseIcon />}
              disabled={decide.isPending}
              onClick={() => {
                setNotes('');
                setDecision({ request: r, action: 'reject' });
              }}
            >
              Decline
            </Button>
          </Stack>
        ) : null,
    },
  ];

  const emptyCopy = EMPTY_COPY[status] ?? EMPTY_COPY.PENDING;
  const pendingCount = status === 'PENDING' ? (list.data?.length ?? 0) : 0;

  return (
    <>
      <PageHeader
        title="Manual entries"
        subtitle="Punches typed in by hand — attendance is recorded only once you accept"
      />

      {pendingCount > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {pendingCount === 1 ? 'One person is' : `${pendingCount} people are`} waiting on a
          decision. Until you accept, {pendingCount === 1 ? 'they are' : 'they are'} not counted in
          &ldquo;on site now&rdquo; or in the emergency headcount.
        </Alert>
      )}

      <Tabs value={status} onChange={(_, v) => setStatus(v)} sx={{ mb: 2 }}>
        <Tab label="Pending" value="PENDING" />
        <Tab label="Accepted" value="APPROVED" />
        <Tab label="Declined" value="REJECTED" />
      </Tabs>

      <DataTable
        columns={columns}
        rows={list.data}
        loading={list.isLoading}
        rowKey={(r) => r.id}
        emptyTitle={emptyCopy.title}
        emptyDescription={emptyCopy.description}
      />

      <ConfirmDialog
        open={!!decision}
        title={decision?.action === 'approve' ? 'Accept this entry?' : 'Decline this entry?'}
        message={
          decision ? (
            <>
              <Typography variant="body2" gutterBottom>
                {decision.action === 'approve'
                  ? `${decision.request.worker?.fullName ?? 'This worker'} will be recorded as ${
                      decision.request.tapType === 'LOGIN' ? 'logged in' : 'logged out'
                    } at ${new Date(decision.request.recordedAt).toLocaleString()}.`
                  : `${
                      decision.request.worker?.fullName ?? 'This worker'
                    }'s attendance will be left exactly as it is. Nothing is recorded.`}
              </Typography>
              <TextField
                fullWidth
                size="small"
                sx={{ mt: 2 }}
                label={decision.action === 'approve' ? 'Note (optional)' : 'Reason (optional)'}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </>
          ) : (
            ''
          )
        }
        confirmLabel={decision?.action === 'approve' ? 'Accept' : 'Decline'}
        danger={decision?.action === 'reject'}
        busy={decide.isPending}
        onConfirm={() =>
          decision &&
          decide.mutate({
            id: decision.request.id,
            action: decision.action,
            reviewNotes: notes.trim(),
          })
        }
        onClose={() => setDecision(null)}
      />
    </>
  );
}
