'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PersonAddAltOutlinedIcon from '@mui/icons-material/PersonAddAltOutlined';
import { useForm } from 'react-hook-form';
import { api, apiErrorMessage } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { DataTable, Column } from '@/components/ui/DataTable';
import { StatusBadge, BadgeTone } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useToast } from '@/components/ui/Toast';
import { roleLabel } from '@/lib/rbac';
import { UserRole } from '@/lib/types';

interface UserRow {
  id: string;
  fullName: string;
  email: string | null;
  username: string | null;
  role: UserRole;
  isActive: boolean;
  canApplyCorrections: boolean;
}

interface UserForm {
  fullName: string;
  email: string;
  username: string;
  password: string;
  role: UserRole;
  canApplyCorrections: boolean;
}

/** Roles that can file a correction at all — the grant is meaningless elsewhere. */
const CORRECTION_ROLES: UserRole[] = ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR'];

/** Matches what the API's @IsEmail() will accept, so we fail fast in the form. */
const EMAIL_RULE = {
  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  message: 'Enter a valid email address',
} as const;

interface Me {
  id: string;
  role: UserRole;
}

/** Soft role badge — one consistent tone per role across the panel. */
function RoleBadge({ role }: { role: UserRole }) {
  if (role === 'SITE_ADMIN') {
    // Primary-tinted badge: admins carry the brand color.
    return (
      <StatusBadge
        label={roleLabel(role)}
        sx={{
          bgcolor: (t) => alpha(t.palette.primary.main, 0.12),
          color: 'primary.main',
        }}
      />
    );
  }
  const tone: BadgeTone =
    role === 'SUPER_ADMIN' ? 'info' : role === 'SUPERVISOR' ? 'success' : 'neutral';
  return <StatusBadge label={roleLabel(role)} tone={tone} />;
}

export default function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<UserRow | null>(null);
  const [deleting, setDeleting] = React.useState<UserRow | null>(null);
  const [toggling, setToggling] = React.useState<UserRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<UserForm>({
    defaultValues: { role: 'WATCHMAN' },
  });
  const selectedRole = watch('role');

  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/auth/me') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/users') });

  const isSuperAdmin = me.data?.role === 'SUPER_ADMIN';
  // Admins can only create/edit Safety Officers & Watchmen; Super Admin: all.
  const assignableRoles: UserRole[] = isSuperAdmin
    ? ['SUPER_ADMIN', 'SITE_ADMIN', 'SUPERVISOR', 'WATCHMAN']
    : ['SUPERVISOR', 'WATCHMAN'];
  const canManage = (u: UserRow) =>
    isSuperAdmin || u.role === 'SUPERVISOR' || u.role === 'WATCHMAN' || u.id === me.data?.id;

  const refresh = () => qc.invalidateQueries({ queryKey: ['users'] });
  const fail = (e: unknown, fallback: string) => setError(apiErrorMessage(e, fallback));

  const save = useMutation({
    mutationFn: (v: UserForm) => {
      // Only watchmen have a username; every other role signs in with email.
      // The hidden field keeps whatever was typed into it before the role was
      // switched, so decide what to send from the role, never from the value.
      const isWatchman = v.role === 'WATCHMAN';
      const email = v.email?.trim() ?? '';
      const username = v.username?.trim() ?? '';

      const body: Record<string, unknown> = {
        fullName: v.fullName,
        role: v.role,
        // Blank password = keep the existing one.
        ...(v.password ? { password: v.password } : {}),
      };

      // Only the Super Admin may send this key at all — the API rejects it from
      // anyone else, so an Admin editing a Safety Officer must not include it.
      if (isSuperAdmin) {
        body.canApplyCorrections = CORRECTION_ROLES.includes(v.role)
          ? !!v.canApplyCorrections
          : false;
      }

      if (isWatchman) {
        body.username = username;
        // A watchman's email is optional: on edit, blank means "clear it", and
        // only an explicit null does that — omitting the key leaves it alone.
        if (editing) body.email = email || null;
        else if (email) body.email = email;
      } else {
        body.email = email;
        // Switching a watchman to an email role must drop their username,
        // otherwise it lingers and blocks reuse of that handle.
        if (editing) body.username = null;
      }

      return editing ? api.patch(`/users/${editing.id}`, body) : api.post('/users', body);
    },
    onSuccess: () => {
      refresh();
      setOpen(false);
      setError(null);
      toast.success(editing ? 'Changes saved' : 'User created');
      reset({
        fullName: '',
        email: '',
        username: '',
        password: '',
        role: 'WATCHMAN',
        canApplyCorrections: false,
      });
    },
    onError: (e) => fail(e, 'Failed to save user'),
  });

  const toggleActive = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/users/${u.id}`, { isActive: !u.isActive }),
    onSuccess: (_, u) => {
      refresh();
      setToggling(null);
      toast.success(`${u.fullName} ${u.isActive ? 'deactivated' : 're-activated'}`);
    },
    onError: (e) => {
      setToggling(null);
      fail(e, 'Failed to update user');
    },
  });

  const remove = useMutation({
    mutationFn: (u: UserRow) => api.del(`/users/${u.id}`),
    onSuccess: (_, u) => {
      refresh();
      setDeleting(null);
      toast.success(`${u.fullName} deleted`);
    },
    onError: (e) => {
      setDeleting(null);
      fail(e, 'Failed to delete user');
    },
  });

  const openCreate = () => {
    setEditing(null);
    setError(null);
    reset({
      fullName: '',
      email: '',
      username: '',
      password: '',
      role: assignableRoles[assignableRoles.length - 1],
      canApplyCorrections: false,
    });
    setOpen(true);
  };
  const openEdit = (u: UserRow) => {
    setEditing(u);
    setError(null);
    reset({
      fullName: u.fullName,
      email: u.email ?? '',
      username: u.username ?? '',
      password: '',
      role: u.role,
      canApplyCorrections: u.canApplyCorrections,
    });
    setOpen(true);
  };

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      label: 'Name',
      render: (u) => (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {u.fullName}
        </Typography>
      ),
    },
    {
      key: 'login',
      label: 'Email / User ID',
      render: (u) => (
        <Typography variant="body2" color="text.secondary">
          {u.email ?? u.username ?? '—'}
        </Typography>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      render: (u) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <RoleBadge role={u.role} />
          {u.canApplyCorrections && (
            <Tooltip title="Their attendance corrections apply immediately, without approval">
              <span>
                <StatusBadge label="Applies corrections" tone="warning" />
              </span>
            </Tooltip>
          )}
        </Stack>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      render: (u) =>
        canManage(u) ? (
          <Tooltip title={u.isActive ? 'Click to deactivate' : 'Click to re-activate'}>
            <span>
              <StatusBadge
                label={u.isActive ? 'Active' : 'Inactive'}
                tone={u.isActive ? 'success' : 'neutral'}
                onClick={() => setToggling(u)}
              />
            </span>
          </Tooltip>
        ) : (
          <StatusBadge
            label={u.isActive ? 'Active' : 'Inactive'}
            tone={u.isActive ? 'success' : 'neutral'}
          />
        ),
    },
    {
      key: 'actions',
      label: 'Actions',
      align: 'right',
      width: 110,
      render: (u) => (
        <>
          {canManage(u) && (
            <IconButton size="small" title="Edit user" onClick={() => openEdit(u)}>
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          )}
          {isSuperAdmin && u.id !== me.data?.id && (
            <IconButton
              size="small"
              color="error"
              title="Delete user"
              onClick={() => setDeleting(u)}
            >
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          )}
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Admins, safety officers and watchmen"
        action={
          <Button variant="contained" startIcon={<PersonAddAltOutlinedIcon />} onClick={openCreate}>
            New user
          </Button>
        }
      />
      {error && !open && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <DataTable
        columns={columns}
        rows={users.data}
        loading={users.isLoading}
        rowKey={(u) => u.id}
        emptyTitle="No users yet"
        emptyDescription="Create accounts for admins, safety officers and watchmen."
        emptyAction={
          <Button variant="contained" onClick={openCreate}>
            New user
          </Button>
        }
      />

      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>{editing ? `Edit user — ${editing.fullName}` : 'New user'}</DialogTitle>
        <form onSubmit={handleSubmit((v) => save.mutate(v))}>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField
                select
                label="Role"
                defaultValue={editing?.role ?? 'WATCHMAN'}
                fullWidth
                {...register('role')}
              >
                {assignableRoles.map((r) => (
                  <MenuItem key={r} value={r}>
                    {roleLabel(r)}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                label="Full name"
                fullWidth
                InputLabelProps={{ shrink: true }}
                error={!!errors.fullName}
                helperText={errors.fullName?.message}
                {...register('fullName', {
                  required: 'Full name is required',
                  minLength: { value: 2, message: 'Full name is too short' },
                })}
              />
              {selectedRole === 'WATCHMAN' ? (
                <>
                  <TextField
                    label="User ID (used to sign in)"
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                    error={!!errors.username}
                    helperText={
                      errors.username?.message ?? 'Watchmen sign in with this ID — no email needed'
                    }
                    {...register('username', {
                      required: 'A user ID is required for watchmen',
                      minLength: { value: 3, message: 'At least 3 characters' },
                      pattern: {
                        value: /^[a-zA-Z0-9._-]+$/,
                        message: 'Only letters, numbers, dots, dashes and underscores',
                      },
                    })}
                  />
                  <TextField
                    label="Email (optional)"
                    type="email"
                    fullWidth
                    InputLabelProps={{ shrink: true }}
                    error={!!errors.email}
                    helperText={errors.email?.message}
                    {...register('email', { pattern: EMAIL_RULE })}
                  />
                </>
              ) : (
                <TextField
                  label="Email"
                  type="email"
                  fullWidth
                  InputLabelProps={{ shrink: true }}
                  error={!!errors.email}
                  helperText={
                    errors.email?.message ??
                    'Required — used for sign-in and password reset codes'
                  }
                  {...register('email', {
                    required: 'Email is required for this role',
                    pattern: EMAIL_RULE,
                  })}
                />
              )}
              <TextField
                label={editing ? 'New password (blank = keep current)' : 'Password'}
                type="password"
                fullWidth
                InputLabelProps={{ shrink: true }}
                error={!!errors.password}
                helperText={errors.password?.message ?? 'At least 8 characters'}
                {...register('password', {
                  // Editing with a blank password keeps the current one; a new
                  // user always needs one. The API enforces 8–128 either way.
                  required: editing ? false : 'Password is required',
                  validate: (v) =>
                    !v || (v.length >= 8 && v.length <= 128) || 'Must be 8–128 characters',
                })}
              />

              {/* Handing out the approval bypass is the Super Admin's call, and
                  the API refuses the field from anyone else — so it is not shown
                  to an Admin at all rather than shown and then rejected. */}
              {isSuperAdmin && CORRECTION_ROLES.includes(selectedRole) && (
                <Box
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1,
                    px: 1.75,
                    py: 1.25,
                  }}
                >
                  <FormControlLabel
                    control={<Checkbox {...register('canApplyCorrections')} defaultChecked={editing?.canApplyCorrections ?? false} />}
                    label="Corrections apply without approval"
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Attendance changes this person files take effect immediately — nobody reviews
                    them first. They are listed under &quot;Applied directly&quot; on the
                    Corrections page.
                  </Typography>
                </Box>
              )}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button color="inherit" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="contained" disabled={save.isPending}>
              {editing ? 'Save changes' : 'Create'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!toggling}
        title={toggling?.isActive ? 'Deactivate user?' : 'Re-activate user?'}
        message={
          toggling
            ? toggling.isActive
              ? `${toggling.fullName} will no longer be able to sign in. You can re-activate them at any time.`
              : `${toggling.fullName} will be able to sign in again.`
            : ''
        }
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Re-activate'}
        danger={!!toggling?.isActive}
        busy={toggleActive.isPending}
        onConfirm={() => toggling && toggleActive.mutate(toggling)}
        onClose={() => setToggling(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        title="Delete user?"
        message={
          deleting
            ? `${deleting.fullName} (${roleLabel(deleting.role)}) will be removed and signed out everywhere. Their history stays in the audit log. This cannot be undone.`
            : ''
        }
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
