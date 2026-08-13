'use client';

import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Avatar,
  Box,
  Button,
  Grid,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import ContactPhoneOutlinedIcon from '@mui/icons-material/ContactPhoneOutlined';
import FileUploadOutlinedIcon from '@mui/icons-material/FileUploadOutlined';
import { api, BrowserApiError } from '@/lib/api/browser';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/ui/SectionCard';
import { useToast } from '@/components/ui/Toast';
import { photoSrc } from '@/components/PeopleDirectory';
import { Organization } from '@/lib/types';

type ProfileForm = {
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string;
  logoScale: number;
};

const EMPTY: ProfileForm = {
  name: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  pincode: '',
  phone: '',
  email: '',
  website: '',
  logoUrl: '',
  logoScale: 1,
};

/** Downscale a logo to ≤400px PNG/JPEG and upload to /files; returns stored url. */
async function uploadLogo(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const maxDim = 400;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const out = canvas.toDataURL('image/png');
  const base64 = out.split(',')[1];
  const res = await api.post<{ url: string }>('/files', {
    dataBase64: base64,
    mimeType: 'image/png',
  });
  return res.url;
}

export default function CompanyPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = React.useState<ProfileForm>(EMPTY);
  const [uploading, setUploading] = React.useState(false);

  const org = useQuery({
    queryKey: ['org-current'],
    queryFn: () => api.get<Organization>('/organizations/current'),
  });

  // Seed the form once the org loads.
  React.useEffect(() => {
    if (!org.data) return;
    setForm({
      name: org.data.name ?? '',
      addressLine1: org.data.addressLine1 ?? '',
      addressLine2: org.data.addressLine2 ?? '',
      city: org.data.city ?? '',
      state: org.data.state ?? '',
      pincode: org.data.pincode ?? '',
      phone: org.data.phone ?? '',
      email: org.data.email ?? '',
      website: org.data.website ?? '',
      logoUrl: org.data.logoUrl ?? '',
      logoScale: org.data.logoScale ?? 1,
    });
  }, [org.data]);

  const set = (k: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const save = useMutation({
    mutationFn: () => {
      // Email is omitted when blank so the @IsEmail validator doesn't reject ''.
      const { email, logoScale, ...rest } = form;
      const body: Record<string, string | number> = { ...rest, logoScale };
      if (email.trim()) body.email = email.trim();
      else body.email = '';
      return api.patch<Organization>('/organizations/current', body);
    },
    onSuccess: () => {
      toast.success('Saved — new cards will use these details');
      qc.invalidateQueries({ queryKey: ['org-current'] });
    },
    onError: (e) => {
      const err = e as BrowserApiError;
      toast.error(err.body?.detail ?? err.body?.title ?? 'Failed to save');
    },
  });

  const onLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadLogo(file);
      setForm((f) => ({ ...f, logoUrl: url }));
    } catch {
      toast.error('Logo upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const saveButton = (
    <Button
      variant="contained"
      disabled={save.isPending || org.isLoading}
      onClick={() => save.mutate()}
    >
      {save.isPending ? 'Saving…' : 'Save changes'}
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Company details"
        subtitle="Name, address and logo — printed on every worker ID card."
        action={saveButton}
      />

      <Stack spacing={2.5} sx={{ maxWidth: 860 }}>
        <SectionCard
          icon={<ImageOutlinedIcon />}
          title="Branding"
          subtitle="Logo shown on printed worker ID cards"
        >
          <Stack direction="row" spacing={2} alignItems="center" sx={{ mb: form.logoUrl ? 3 : 0 }}>
            <Avatar
              src={photoSrc(form.logoUrl)}
              variant="rounded"
              sx={{
                width: 72,
                height: 72,
                bgcolor: 'grey.100',
                color: 'text.secondary',
                fontSize: '0.8rem',
                border: '1px solid',
                borderColor: 'divider',
              }}
            >
              Logo
            </Avatar>
            <Box>
              <Button
                variant="outlined"
                component="label"
                startIcon={<FileUploadOutlinedIcon />}
                disabled={uploading}
              >
                {uploading ? 'Uploading…' : 'Upload logo'}
                <input hidden type="file" accept="image/*" onChange={onLogo} />
              </Button>
              {form.logoUrl && (
                <Button
                  size="small"
                  color="inherit"
                  sx={{ ml: 1 }}
                  onClick={() => setForm((f) => ({ ...f, logoUrl: '' }))}
                >
                  Remove
                </Button>
              )}
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                PNG or JPEG — automatically resized to fit the card.
              </Typography>
            </Box>
          </Stack>

          {form.logoUrl && (
            <Stack direction="row" spacing={3} alignItems="center">
              {/* Clipped preview mimics the logo box on the ID card. */}
              <Box
                sx={{
                  width: 120,
                  height: 56,
                  border: '1px solid',
                  borderColor: 'divider',
                  borderRadius: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'grey.50',
                  flexShrink: 0,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={photoSrc(form.logoUrl)}
                  alt=""
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    transform: `scale(${form.logoScale})`,
                  }}
                />
              </Box>
              <Box sx={{ flex: 1, maxWidth: 320 }}>
                <Typography variant="body2" gutterBottom>
                  Logo zoom on card: {form.logoScale.toFixed(2)}×
                </Typography>
                <Slider
                  value={form.logoScale}
                  min={0.5}
                  max={3}
                  step={0.05}
                  marks={[
                    { value: 1, label: 'Fit' },
                    { value: 2, label: '2×' },
                    { value: 3, label: '3×' },
                  ]}
                  valueLabelDisplay="auto"
                  onChange={(_, v) => {
                    setForm((f) => ({ ...f, logoScale: v as number }));
                  }}
                />
              </Box>
            </Stack>
          )}
        </SectionCard>

        <SectionCard
          icon={<BusinessOutlinedIcon />}
          title="Company details"
          subtitle="Registered name and address"
        >
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Company name"
                value={form.name}
                onChange={set('name')}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Address line 1"
                value={form.addressLine1}
                onChange={set('addressLine1')}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Address line 2"
                value={form.addressLine2}
                onChange={set('addressLine2')}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField fullWidth label="City" value={form.city} onChange={set('city')} />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField fullWidth label="State" value={form.state} onChange={set('state')} />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField
                fullWidth
                label="Pincode"
                value={form.pincode}
                onChange={set('pincode')}
              />
            </Grid>
          </Grid>
        </SectionCard>

        <SectionCard
          icon={<ContactPhoneOutlinedIcon />}
          title="Contact"
          subtitle="Shown on ID cards and documents"
        >
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Phone" value={form.phone} onChange={set('phone')} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField
                fullWidth
                label="Email"
                value={form.email}
                onChange={set('email')}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField
                fullWidth
                label="Website"
                value={form.website}
                onChange={set('website')}
              />
            </Grid>
          </Grid>
        </SectionCard>

        <Stack direction="row" justifyContent="flex-end">{saveButton}</Stack>
      </Stack>
    </>
  );
}
