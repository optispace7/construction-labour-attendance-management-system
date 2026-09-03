'use client';

import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Organization, Worker } from '@/lib/types';
import { qrPayload } from '@/components/QrBadge';
import { photoSrc } from '@/components/PeopleDirectory';
import { DisciplinaryBadges, SafetySeal, TRAINING_SEALS } from '@/components/SafetySeals';

// A card face has two printing routes, and the size means a different thing on
// each. On A4 the sheet is cut up by hand, so S/M/L just scale the whole card
// off CR80 (85.6 x 54 mm). On a desktop PVC card printer the size is the blank
// card being fed, so it has to be one of the real stock sizes.
export type PrintMode = 'A4' | 'PVC';
export type CardSize = 'S' | 'M' | 'L';
export type CardStock = 'CR80' | 'CR79' | 'CR100';
export type CardOrientation = 'portrait' | 'landscape';

export type CardSpec = {
  mode: PrintMode;
  size: CardSize;
  stock: CardStock;
  orientation: CardOrientation;
};

// Blank card stock that desktop PVC printers (Evolis, Fargo, Magicard, Zebra...)
// feed, long edge x short edge in mm. Printing at exactly these sizes lands the
// artwork edge-to-edge on the card.
export const PVC_STOCKS: Record<CardStock, { long: number; short: number; label: string }> = {
  CR80: { long: 85.6, short: 54, label: 'CR80 - Standard (85.6 x 54 mm)' },
  CR79: { long: 83.9, short: 51, label: 'CR79 (83.9 x 51 mm)' },
  CR100: { long: 98.5, short: 67, label: 'CR100 - Oversized (98.5 x 67 mm)' },
};

const SIZE_SCALE: Record<CardSize, number> = { S: 0.82, M: 1, L: 1.22 };
const BASE_LONG = PVC_STOCKS.CR80.long;
const BASE_SHORT = PVC_STOCKS.CR80.short;

/**
 * The printed face in mm, plus `u` - the unit scale every type size, QR and
 * seal is expressed in. u === 1 is a CR80 card, so a card of any other size
 * keeps the same proportions.
 */
export function cardMetrics(spec: CardSpec): { w: number; h: number; u: number } {
  const long = spec.mode === 'PVC' ? PVC_STOCKS[spec.stock].long : BASE_LONG * SIZE_SCALE[spec.size];
  const short =
    spec.mode === 'PVC' ? PVC_STOCKS[spec.stock].short : BASE_SHORT * SIZE_SCALE[spec.size];
  const u = short / BASE_SHORT;
  return spec.orientation === 'portrait' ? { w: short, h: long, u } : { w: long, h: short, u };
}

const NAVY = '#0d1b3e';
const BORDER = '#3a3f47';
const LABEL_BG = '#eef1f5';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(s?: string | null): string {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

function ageFrom(dob?: string | null): string {
  if (!dob) return '';
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return '';
  const t = new Date();
  let a = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
  return a > 0 ? String(a) : '';
}

/** One physical face of a two-sided worker ID card. */
export function IdCard({
  worker,
  org,
  spec,
  side,
}: {
  worker: Worker;
  org?: Organization | null;
  spec: CardSpec;
  side: 'front' | 'back';
}) {
  const { w, h, u } = cardMetrics(spec);
  const logoScale = org?.logoScale ?? 1;

  const shell: React.CSSProperties = {
    width: `${w}mm`,
    height: `${h}mm`,
    boxSizing: 'border-box',
    border: spec.mode === 'A4' ? `1px solid ${BORDER}` : undefined,
    background: '#fff',
    overflow: 'hidden',
    breakInside: 'avoid',
    fontFamily: 'Roboto, system-ui, Arial, sans-serif',
    color: '#111',
    display: 'flex',
    flexDirection: 'column',
    printColorAdjust: 'exact',
    WebkitPrintColorAdjust: 'exact',
  };

  const titleBar = (text: string) => (
    <div
      style={{
        background: NAVY,
        color: '#fff',
        textAlign: 'center',
        fontWeight: 700,
        letterSpacing: 0.6,
        fontSize: `${2.8 * u}mm`,
        padding: `${1.2 * u}mm`,
        printColorAdjust: 'exact',
        WebkitPrintColorAdjust: 'exact',
      }}
    >
      {text}
    </div>
  );

  const footerBar = (text: string) => (
    <div
      style={{
        background: NAVY,
        color: '#fff',
        textAlign: 'center',
        fontWeight: 600,
        fontSize: `${2 * u}mm`,
        padding: `${0.9 * u}mm`,
        printColorAdjust: 'exact',
        WebkitPrintColorAdjust: 'exact',
      }}
    >
      {text}
    </div>
  );

  // A label/value table row. `grow` lets a row stretch to fill the body height.
  const Row = ({
    cells,
    grow,
  }: {
    cells: { label: string; value?: React.ReactNode; labelW?: number; valueFlex?: number }[];
    grow?: number;
  }) => (
    <div style={{ display: 'flex', borderBottom: `0.5px solid ${BORDER}`, flex: grow ?? 'none', minHeight: 0 }}>
      {cells.map((c, i) => (
        <React.Fragment key={i}>
          <div
            style={{
              width: `${(c.labelW ?? 22) * u}mm`,
              flexShrink: 0,
              background: LABEL_BG,
              borderRight: `0.5px solid ${BORDER}`,
              padding: `${0.7 * u}mm ${1.2 * u}mm`,
              fontWeight: 700,
              fontSize: `${2.1 * u}mm`,
              display: 'flex',
              alignItems: 'center',
              printColorAdjust: 'exact',
              WebkitPrintColorAdjust: 'exact',
            }}
          >
            {c.label}
          </div>
          <div
            style={{
              flex: c.valueFlex ?? 1,
              borderRight: i < cells.length - 1 ? `0.5px solid ${BORDER}` : undefined,
              padding: `${0.7 * u}mm ${1.2 * u}mm`,
              fontSize: `${2.3 * u}mm`,
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {c.value}
          </div>
        </React.Fragment>
      ))}
    </div>
  );

  // The bordered box hugs the logo (auto-sizes to it) so there's no empty space;
  // the Company-page zoom (logoScale) drives how large the logo prints.
  const logoBox = () =>
    org?.logoUrl ? (
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photoSrc(org.logoUrl)}
          alt=""
          style={{
            maxHeight: `${7 * u * logoScale}mm`,
            maxWidth: '100%',
            objectFit: 'contain',
            display: 'block',
            border: `0.5px solid ${BORDER}`,
            borderRadius: `${0.8 * u}mm`,
            background: '#fff',
            padding: `${0.5 * u}mm`,
            boxSizing: 'border-box',
          }}
        />
      </div>
    ) : null;

  // ---- Visitor pass: deliberately minimal — name + a QR for sign-in only.
  // No mobile/blood group/other personal details on the pass.
  // Single-sided, so it renders the same regardless of `side`. ----
  if (worker.category === 'VISITOR') {
    return (
      <div style={shell}>
        {titleBar('VISITOR PASS')}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              borderRight: `0.5px solid ${BORDER}`,
              minWidth: 0,
            }}
          >
            {org?.name ? <Row cells={[{ label: 'Company', value: org.name, labelW: 22 }]} grow={1} /> : null}
            <Row cells={[{ label: 'Name', value: worker.fullName, labelW: 22 }]} grow={1} />
          </div>
          <div
            style={{
              width: `${27 * u}mm`,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: `${1 * u}mm`,
              padding: `${1.2 * u}mm`,
            }}
          >
            {logoBox()}
            <QRCodeSVG value={qrPayload(worker.workerCode)} size={Math.round(11 * u * 3.78)} includeMargin={false} />
            <div style={{ fontSize: `${1.8 * u}mm`, fontWeight: 700, lineHeight: 1 }}>{worker.workerCode}</div>
          </div>
        </div>
        {footerBar('Valid for day of issue · Return at exit')}
      </div>
    );
  }

  if (side === 'front') {
    const project = worker.assignments?.[0]?.site?.name ?? '';
    const designation = worker.designation?.name ?? '';
    const sex =
      worker.gender === 'M' ? 'Male' : worker.gender === 'F' ? 'Female' : worker.gender ?? '';
    const emergency = [worker.emergencyContactName, worker.emergencyContactNumber]
      .filter(Boolean)
      .join(' · ');

    return (
      <div style={shell}>
        {titleBar('IDENTITY CARD')}

        {/* Body: details table on the left, logo + photo + badges on the right */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              borderRight: `0.5px solid ${BORDER}`,
              minWidth: 0,
            }}
          >
            <Row cells={[{ label: 'Project Name', value: project }]} grow={1} />
            <Row cells={[{ label: 'Employee name', value: worker.fullName }]} grow={1} />
            <Row cells={[{ label: 'ID No', value: worker.workerCode }]} grow={1} />
            <Row cells={[{ label: 'JOB Title', value: designation }]} grow={1} />
            <Row
              cells={[
                { label: 'Age', value: ageFrom(worker.dateOfBirth), labelW: 10, valueFlex: 1 },
                { label: 'Sex', value: sex, labelW: 10, valueFlex: 1 },
              ]}
              grow={1}
            />
            <Row cells={[{ label: 'Blood Group', value: worker.bloodGroup ?? '' }]} grow={1} />
            <Row cells={[{ label: 'Emergency Contact', value: emergency, labelW: 26 }]} grow={1} />
          </div>

          {/* Right column: company logo, photo, then disciplinary badges */}
          <div
            style={{
              width: `${27 * u}mm`,
              flexShrink: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: `${1.2 * u}mm`,
              gap: `${1 * u}mm`,
            }}
          >
            {logoBox()}
            <div
              style={{
                flex: 1,
                minHeight: 0,
                borderRadius: `${1 * u}mm`,
                background: '#eef1f4',
                border: `0.5px solid ${BORDER}`,
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {worker.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={photoSrc(worker.photoUrl)}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                <span style={{ fontSize: `${2 * u}mm`, color: '#9aa3ab' }}>Photo</span>
              )}
            </div>
            <div>
              <DisciplinaryBadges px={Math.round(7.8 * u * 3.78)} />
              <div
                style={{
                  textAlign: 'center',
                  fontSize: `${1.5 * u}mm`,
                  color: '#444',
                  marginTop: `${0.4 * u}mm`,
                  lineHeight: 1.1,
                }}
              >
                Disciplinary Action on Safety Violation
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ---- Back face: company + induction details, QR, training seals ----
  // Screening and induction are one and the same step on site, so the card
  // carries induction only — the old "Screening done on/by" rows are gone.
  // Seal size kept to what fits the row (no clipping); the larger curved text +
  // wider colour band keep it readable. QR only slightly larger so it doesn't
  // squeeze the seal row.
  const qrPx = Math.round(9.5 * u * 3.78);
  const sealPx = Math.round(8.5 * u * 3.78);

  return (
    <div style={shell}>
      {titleBar('INDUCTION CARD')}

      {/* Company + induction rows on the left, QR on the right */}
      <div style={{ display: 'flex', borderBottom: `0.5px solid ${BORDER}`, flexShrink: 0 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Row cells={[{ label: 'Name of the Company', value: org?.name ?? '', labelW: 30 }]} />
          <Row
            cells={[
              { label: 'Induction Done on', value: fmtDate(worker.inductionDoneOn), labelW: 30 },
            ]}
          />
          <Row cells={[{ label: 'Inducted By', value: worker.inductedBy ?? '', labelW: 30 }]} />
        </div>
        <div
          style={{
            width: `${17 * u}mm`,
            flexShrink: 0,
            borderLeft: `0.5px solid ${BORDER}`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: `${0.5 * u}mm`,
          }}
        >
          <QRCodeSVG value={qrPayload(worker.workerCode)} size={qrPx} includeMargin={false} />
          <div style={{ fontSize: `${1.8 * u}mm`, fontWeight: 700, marginTop: `${0.4 * u}mm`, lineHeight: 1 }}>
            {worker.workerCode}
          </div>
        </div>
      </div>

      {/* Computer-generated note (comes right after the induction details) */}
      <div
        style={{
          flexShrink: 0,
          fontSize: `${1.7 * u}mm`,
          fontStyle: 'italic',
          color: '#555',
          textAlign: 'center',
          padding: `${0.55 * u}mm ${1.2 * u}mm`,
          borderBottom: `0.5px solid ${BORDER}`,
        }}
      >
        This card is computer-generated and does not require a company seal or signature.
      </div>

      {/* Job-specific training seals (fills remaining height; clipped so it can never overlap) */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
          padding: `${0.8 * u}mm ${1.4 * u}mm`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ flexShrink: 0, fontWeight: 700, fontSize: `${1.9 * u}mm`, marginBottom: `${0.5 * u}mm` }}>
          Job Specific Training Attended:
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: `${0.5 * u}mm`,
          }}
        >
          {TRAINING_SEALS.map((s) => (
            <SafetySeal key={s.key} seal={s} px={sealPx} />
          ))}
        </div>
      </div>

      <div style={{ flexShrink: 0 }}>
        <Row cells={[{ label: 'Validity till', value: fmtDate(worker.validityTill), labelW: 26 }]} />
      </div>

      {footerBar('If Found, Please Return to Project Office')}
    </div>
  );
}
