'use client';

import * as React from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
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
  TextField,
  Typography,
} from '@mui/material';
import { useForm, Controller } from 'react-hook-form';
import { api } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { useToast } from '@/components/ui/Toast';
import { SiteSettings } from '@/lib/types';

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Box sx={{ px: 2.5, pt: 2, pb: 1.5 }}>
        <Typography variant="subtitle1">{title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      </Box>
      <Divider />
      <CardContent sx={{ px: 2.5 }}>{children}</CardContent>
    </Card>
  );
}

export default function SiteSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();

  const settings = useQuery({
    queryKey: ['site-settings', id],
    queryFn: () => api.get<SiteSettings>(`/sites/${id}/settings`),
  });

  const { register, handleSubmit, control, reset } = useForm<SiteSettings>();

  React.useEffect(() => {
    if (settings.data) reset(settings.data);
  }, [settings.data, reset]);

  const save = useMutation({
    mutationFn: (v: SiteSettings) =>
      api.put(`/sites/${id}/settings`, {
        verificationMode: v.verificationMode,
        autoLoginCountdownSeconds: Number(v.autoLoginCountdownSeconds),
        duplicateTapCooldownSeconds: Number(v.duplicateTapCooldownSeconds),
        safetyGapMinutes: Number(v.safetyGapMinutes),
        geoEnforcement: v.geoEnforcement,
        geoRadiusMeters: Number(v.geoRadiusMeters),
        photoVerificationMode: v.photoVerificationMode,
        photoVerificationRandomPct: Number(v.photoVerificationRandomPct),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['site-settings', id] });
      toast.success('Settings saved');
    },
    onError: () => toast.error('Failed to save settings'),
  });

  if (!settings.data) return null;

  return (
    <>
      <PageHeader title="Site settings" subtitle="Verification, cooldown, geo and photo policy" />
      <form onSubmit={handleSubmit((v) => save.mutate(v))}>
        <Stack spacing={2}>
          <SectionCard
            title="Verification"
            subtitle="How attendance taps are confirmed at the gate"
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} md={4}>
                <Controller
                  name="verificationMode"
                  control={control}
                  render={({ field }) => (
                    <TextField select label="Verification mode" fullWidth {...field}>
                      <MenuItem value="MANUAL">Manual (watchman confirms)</MenuItem>
                      <MenuItem value="AUTO">Auto (countdown)</MenuItem>
                    </TextField>
                  )}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  label="Auto-login countdown (s)"
                  type="number"
                  fullWidth
                  {...register('autoLoginCountdownSeconds')}
                />
              </Grid>
            </Grid>
          </SectionCard>

          <SectionCard
            title="Double-scan protection"
            subtitle="Two guards against one badge being read twice at the gate"
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Duplicate-tap cooldown (s)"
                  type="number"
                  fullWidth
                  helperText="Repeat scans of the same badge within this many seconds are ignored."
                  {...register('duplicateTapCooldownSeconds')}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Safety gap (min)"
                  type="number"
                  fullWidth
                  helperText={
                    'How long a worker must stay logged in before a scan can log them out ' +
                    '(and stay out before scanning back in). The watchman can override with a ' +
                    'reason. Visitors are exempt. 0 turns it off.'
                  }
                  {...register('safetyGapMinutes')}
                />
              </Grid>
            </Grid>
          </SectionCard>

          <SectionCard
            title="Geofence"
            subtitle="Restrict attendance to devices physically at the site"
          >
            <Grid container spacing={2.5} alignItems="center">
              <Grid item xs={12} md={6}>
                <Controller
                  name="geoEnforcement"
                  control={control}
                  render={({ field }) => (
                    <FormControlLabel
                      control={<Switch checked={!!field.value} onChange={field.onChange} />}
                      label="Enforce geofence"
                    />
                  )}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Geofence radius (m)"
                  type="number"
                  fullWidth
                  {...register('geoRadiusMeters')}
                />
              </Grid>
            </Grid>
          </SectionCard>

          <SectionCard
            title="Photo verification"
            subtitle="When a photo is requested along with the attendance tap"
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} md={6}>
                <Controller
                  name="photoVerificationMode"
                  control={control}
                  render={({ field }) => (
                    <TextField select label="Photo verification" fullWidth {...field}>
                      <MenuItem value="ALWAYS">Always</MenuItem>
                      <MenuItem value="NEVER">Never</MenuItem>
                      <MenuItem value="RANDOM">Random</MenuItem>
                    </TextField>
                  )}
                />
              </Grid>
              <Grid item xs={12} md={6}>
                <TextField
                  label="Random photo verification (%)"
                  type="number"
                  fullWidth
                  {...register('photoVerificationRandomPct')}
                />
              </Grid>
            </Grid>
          </SectionCard>

          <Stack direction="row" justifyContent="flex-end">
            <Button type="submit" variant="contained" disabled={save.isPending}>
              Save settings
            </Button>
          </Stack>
        </Stack>
      </form>
    </>
  );
}
