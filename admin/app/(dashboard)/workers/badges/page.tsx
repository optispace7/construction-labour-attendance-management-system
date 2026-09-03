'use client';

import * as React from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Box, Button, Checkbox, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { api } from '@/lib/api/browser';
import { Organization, Paginated, PersonCategory, Site, Worker } from '@/lib/types';
import {
  CardSize,
  CardSpec,
  CardStock,
  IdCard,
  PVC_STOCKS,
  PrintMode,
  cardMetrics,
} from '@/components/IdCard';
import { StaffIdCard } from '@/components/StaffIdCard';

const CATEGORY_TITLES: Record<PersonCategory, string> = {
  WORKER: 'Worker ID cards',
  STAFF: 'Staff ID cards',
  VISITOR: 'Visitor passes',
};

// Remembered as the defaults for next time (per-browser).
const SIZE_KEY = 'clams.badge.size';
const STOCK_KEY = 'clams.badge.stock';
// Print route is remembered per person type, because the answer differs: staff
// cards go on PVC blanks, while worker cards and visitor passes are run off on
// A4 and cut out.
const modeKey = (c: PersonCategory) => `clams.badge.mode.${c}`;
const defaultMode = (c: PersonCategory): PrintMode => (c === 'STAFF' ? 'PVC' : 'A4');

export default function BadgesPage() {
  const params = useSearchParams();
  const initial = (params.get('category') ?? 'WORKER').toUpperCase() as PersonCategory;
  const [category, setCategory] = React.useState<PersonCategory>(
    ['WORKER', 'STAFF', 'VISITOR'].includes(initial) ? initial : 'WORKER',
  );
  const [siteId, setSiteId] = React.useState('');
  const [q, setQ] = React.useState('');

  // Print route and size, restored from localStorage after mount (avoids an SSR
  // hydration mismatch), and written back whenever the admin changes them.
  const [mode, setMode] = React.useState<PrintMode>(() => defaultMode(initial));
  const [size, setSize] = React.useState<CardSize>('M');
  const [stock, setStock] = React.useState<CardStock>('CR80');
  React.useEffect(() => {
    const s = localStorage.getItem(SIZE_KEY);
    if (s === 'S' || s === 'M' || s === 'L') setSize(s);
    const k = localStorage.getItem(STOCK_KEY);
    if (k === 'CR80' || k === 'CR79' || k === 'CR100') setStock(k);
  }, []);
  // Re-read on every category change: switching Workers -> Staff has to switch
  // the print route with it, or a staff run silently goes out as an A4 sheet.
  React.useEffect(() => {
    const m = localStorage.getItem(modeKey(category));
    setMode(m === 'A4' || m === 'PVC' ? m : defaultMode(category));
  }, [category]);
  const chooseMode = (m: PrintMode) => {
    setMode(m);
    localStorage.setItem(modeKey(category), m);
  };
  const chooseSize = (s: CardSize) => {
    setSize(s);
    localStorage.setItem(SIZE_KEY, s);
  };
  const chooseStock = (s: CardStock) => {
    setStock(s);
    localStorage.setItem(STOCK_KEY, s);
  };

  const isVisitor = category === 'VISITOR';
  const isStaff = category === 'STAFF';
  // Staff cards follow the company's corporate artwork, which is portrait.
  // Worker cards and visitor passes stay landscape.
  const spec: CardSpec = {
    mode,
    size,
    stock,
    orientation: isStaff ? 'portrait' : 'landscape',
  };
  const { w: faceW, h: faceH } = cardMetrics(spec);
  const isPvc = mode === 'PVC';

  const org = useQuery({
    queryKey: ['org-current'],
    queryFn: () => api.get<Organization>('/organizations/current'),
  });
  const sites = useQuery({ queryKey: ['sites'], queryFn: () => api.get<Site[]>('/sites') });
  const workers = useQuery({
    queryKey: ['workers', 'all-badges', category, siteId, q],
    queryFn: () =>
      api.get<Paginated<Worker>>(
        `/workers?limit=200&category=${category}${siteId ? `&siteId=${siteId}` : ''}${
          q ? `&q=${encodeURIComponent(q)}` : ''
        }`,
      ),
  });

  const list = React.useMemo(() => workers.data?.data ?? [], [workers.data]);

  // Everyone in the current filter starts selected; untick to leave them out.
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    setSelected(new Set(list.map((w) => w.id)));
  }, [list]);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedCount = list.filter((w) => selected.has(w.id)).length;

  // PVC only: the last selected card's final face must NOT force a page break,
  // otherwise the printer ejects a blank trailing card.
  const lastSelectedId = React.useMemo(() => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (selected.has(list[i].id)) return list[i].id;
    }
    return null;
  }, [list, selected]);

  return (
    <Box>
      {/* Controls hidden when printing */}
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        flexWrap="wrap"
        useFlexGap
        sx={{ mb: 3, '@media print': { display: 'none' } }}
      >
        <Typography variant="h5" sx={{ flexGrow: 1 }}>
          {CATEGORY_TITLES[category]}
        </Typography>
        <TextField
          size="small"
          placeholder="Search name / code / mobile"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ width: 220 }}
        />
        <TextField
          select
          size="small"
          label="Type"
          value={category}
          onChange={(e) => setCategory(e.target.value as PersonCategory)}
          sx={{ width: 130 }}
        >
          <MenuItem value="WORKER">Workers</MenuItem>
          <MenuItem value="STAFF">Staff</MenuItem>
          <MenuItem value="VISITOR">Visitors</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Site"
          value={siteId}
          onChange={(e) => setSiteId(e.target.value)}
          sx={{ width: 180 }}
        >
          <MenuItem value="">All sites</MenuItem>
          {sites.data?.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              {s.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Print on"
          value={mode}
          onChange={(e) => chooseMode(e.target.value as PrintMode)}
          sx={{ width: 190 }}
        >
          <MenuItem value="A4">A4 sheet (cut out)</MenuItem>
          <MenuItem value="PVC">PVC card printer</MenuItem>
        </TextField>
        {isPvc ? (
          <TextField
            select
            size="small"
            label="Card stock"
            value={stock}
            onChange={(e) => chooseStock(e.target.value as CardStock)}
            sx={{ width: 240 }}
          >
            {(Object.keys(PVC_STOCKS) as CardStock[]).map((k) => (
              <MenuItem key={k} value={k}>
                {PVC_STOCKS[k].label}
              </MenuItem>
            ))}
          </TextField>
        ) : (
          <TextField
            select
            size="small"
            label="Size"
            value={size}
            onChange={(e) => chooseSize(e.target.value as CardSize)}
            sx={{ width: 120 }}
          >
            <MenuItem value="S">Small</MenuItem>
            <MenuItem value="M">Medium</MenuItem>
            <MenuItem value="L">Large</MenuItem>
          </TextField>
        )}
        <Button size="small" onClick={() => setSelected(new Set(list.map((w) => w.id)))}>
          Select all
        </Button>
        <Button size="small" onClick={() => setSelected(new Set())}>
          Clear
        </Button>
        <Button variant="contained" onClick={() => window.print()} disabled={selectedCount === 0}>
          Print selected ({selectedCount})
        </Button>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2, '@media print': { display: 'none' } }}>
        {isPvc ? (
          <>
            Each face prints on its own {faceW} × {faceH} mm page, front then back, so a card
            printer feeds one blank per face — set the print dialog to &ldquo;Actual size&rdquo; /
            100% scale with no margins.
          </>
        ) : (
          <>Cards are laid out on A4 with cut gaps between them; trim along the hairlines.</>
        )}
      </Typography>

      {!org.isLoading && !org.data?.name && (
        <Typography variant="body2" color="warning.main" sx={{ mb: 2, '@media print': { display: 'none' } }}>
          Tip: set your company name and address on the Company page so they appear on every card.
        </Typography>
      )}

      {/* @page only ever applies to print, so it is left unnested (Chrome applies
          a bare @page more reliably than one wrapped in @media print). On A4 the
          cards flow across the sheet; on PVC the page IS the card, so the paper
          size has to match the stock exactly and carry no margin. */}
      <style>
        {isPvc
          ? `@page { size: ${faceW}mm ${faceH}mm; margin: 0; }`
          : `@page { size: A4; margin: 10mm; }`}
      </style>

      <Box
        className={isPvc ? 'print-area pvc' : 'print-area'}
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 2,
          // Wider gaps between cards on paper leave room to cut them apart.
          '@media print': { gap: '10mm' },
        }}
      >
        {list.map((w) => {
          const isSelected = selected.has(w.id);
          return (
            <Box
              key={w.id}
              onClick={() => toggle(w.id)}
              className={[
                isSelected ? '' : 'pvc-skip',
                isSelected && w.id === lastSelectedId ? 'pvc-last' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              sx={{
                // Never split a card across two A4 pages.
                breakInside: 'avoid',
                pageBreakInside: 'avoid',
                position: 'relative',
                cursor: 'pointer',
                borderRadius: 1,
                p: 0.5,
                outline: isSelected ? '2px solid' : '2px dashed',
                outlineColor: isSelected ? 'primary.main' : 'divider',
                opacity: isSelected ? 1 : 0.45,
                // Unselected cards vanish from the printout entirely.
                '@media print': isSelected
                  ? { outline: 'none', opacity: 1, p: 0 }
                  : { display: 'none' },
              }}
            >
              <Checkbox
                checked={isSelected}
                onClick={(e) => e.stopPropagation()}
                onChange={() => toggle(w.id)}
                size="small"
                sx={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  zIndex: 1,
                  '@media print': { display: 'none' },
                }}
              />
              {/* Visitor passes are single-sided (name + QR only); worker and
                  staff cards keep front + back side by side on screen and on
                  A4, so the pair can be cut out and laminated double-sided. */}
              <Stack
                direction="row"
                spacing={0.5}
                sx={{ breakInside: 'avoid', '@media print': { gap: '6mm' } }}
              >
                <Box className="pvc-face">
                  {isStaff ? (
                    <StaffIdCard worker={w} org={org.data} spec={spec} side="front" />
                  ) : (
                    <IdCard worker={w} org={org.data} spec={spec} side="front" />
                  )}
                </Box>
                {!isVisitor && (
                  <Box className="pvc-face">
                    {isStaff ? (
                      <StaffIdCard worker={w} org={org.data} spec={spec} side="back" />
                    ) : (
                      <IdCard worker={w} org={org.data} spec={spec} side="back" />
                    )}
                  </Box>
                )}
              </Stack>
            </Box>
          );
        })}
        {list.length === 0 && (
          <Typography color="text.secondary">Nothing to print for this selection.</Typography>
        )}
      </Box>
    </Box>
  );
}
