import * as React from 'react';

/**
 * The panel's icon family.
 *
 * Hand-drawn rather than pulled from Material: the Material set is the single
 * most recognisable "this is a default admin template" signal there is, and it
 * sits at a different weight and corner radius from the icons the dashboard
 * already draws inline. One family, one 24×24 grid, one 1.7 stroke, round caps
 * and joins throughout — so a nav icon and a KPI icon look like they were cut
 * by the same hand.
 *
 * Stroke, not fill, at every size. Filled glyphs at 18px turn into blobs on the
 * dark rail, and an outline reads as a diagram, which suits a product about
 * gates and registers.
 */

export type IconProps = React.SVGProps<SVGSVGElement>;

function Icon({ children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ---- Navigation ---- */

export const DashboardIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="8.5" rx="1.6" />
    <rect x="13.5" y="3" width="7.5" height="5.5" rx="1.6" />
    <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.6" />
    <rect x="13.5" y="11.5" width="7.5" height="9.5" rx="1.6" />
  </Icon>
);

export const AttendanceIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4H6.5A1.5 1.5 0 0 0 5 5.5v14A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-14A1.5 1.5 0 0 0 17.5 4H16" />
    <rect x="8" y="2.5" width="8" height="3.2" rx="1.1" />
    <path d="m8.8 13 2.1 2.1 4.3-4.3" />
  </Icon>
);

export const WrenchIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15.2 3.4a5 5 0 0 0-6.1 6.4L3.6 15.3a2 2 0 0 0 0 2.8l2.3 2.3a2 2 0 0 0 2.8 0l5.5-5.5a5 5 0 0 0 6.4-6.1l-3 3-2.9-.8-.8-2.9Z" />
  </Icon>
);

export const RuleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6h8M3 12h5.5M3 18h8" />
    <path d="m14 7.5 2 2 4-4M14 17.5l2 2 4-4" />
  </Icon>
);

export const PendingIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4H6.5A1.5 1.5 0 0 0 5 5.5v14A1.5 1.5 0 0 0 6.5 21h5" />
    <rect x="8" y="2.5" width="8" height="3.2" rx="1.1" />
    <circle cx="16.5" cy="15.5" r="4.5" />
    <path d="M16.5 13.4v2.1l1.4 1" />
  </Icon>
);

export const ReportsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 20.5h17" />
    <path d="M6.5 20.5v-6M11 20.5V8M15.5 20.5v-8.5M20 20.5V4.5" />
  </Icon>
);

export const HelmetIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 16a8.5 8.5 0 0 1 17 0" />
    <path d="M2.5 16h19v2a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2v-2Z" />
    <path d="M10 7.4V4.8a.8.8 0 0 1 .8-.8h2.4a.8.8 0 0 1 .8.8v2.6" />
  </Icon>
);

/** Shield with a cross — the safety board. */
export const SafetyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2 19.2 6v6.1c0 4.2-2.9 7.4-7.2 8.7-4.3-1.3-7.2-4.5-7.2-8.7V6L12 3.2Z" />
    <path d="M12 9.2v5.2" />
    <path d="M9.4 11.8h5.2" />
  </Icon>
);

/** Clipboard with a tick — the day's task list. */
export const DailyTaskIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.6" y="4.8" width="14.8" height="15.4" rx="2.1" />
    <path d="M9 4.8V3.6A.9.9 0 0 1 9.9 2.7h4.2a.9.9 0 0 1 .9.9v1.2" />
    <path d="M8.9 13.4l2.1 2.1 4.1-4.4" />
  </Icon>
);

export const BadgeIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="6" width="17" height="14.5" rx="2.2" />
    <path d="M9 6V4.6A1.6 1.6 0 0 1 10.6 3h2.8A1.6 1.6 0 0 1 15 4.6V6" />
    <circle cx="12" cy="12" r="2.1" />
    <path d="M8.6 17.4c.7-1.5 2-2.4 3.4-2.4s2.7.9 3.4 2.4" />
  </Icon>
);

export const VisitorsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.3" />
    <path d="M3 19.5a6 6 0 0 1 12 0" />
    <path d="M16.2 5.2a3.3 3.3 0 0 1 0 5.6M18 19.5a6 6 0 0 0-2.2-4.6" />
  </Icon>
);

export const SitesIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 20.5h18" />
    <path d="M5.5 20.5V6.2l7-3.2v17.5M18.5 20.5v-9.3l-6-2.7" />
    <path d="M8.8 8.6v.01M8.8 12.1v.01M8.8 15.6v.01M15.3 13.2v.01M15.3 16.7v.01" />
  </Icon>
);

export const VendorsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m11 7.5 1-1 3.4 3.4a1.7 1.7 0 0 1-2.4 2.4l-.9-.9" />
    <path d="m12.1 11.4 1.8 1.8a1.6 1.6 0 0 1-2.3 2.3l-.4-.4" />
    <path d="m11.2 15.1.6.6a1.5 1.5 0 0 1-2.1 2.1l-3.5-3.5" />
    <path d="M3 12.5 7.5 8l3.5 3.5" />
    <path d="M21 12.5 16.5 8" />
  </Icon>
);

export const DesignationsIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="7" width="18" height="13" rx="2.2" />
    <path d="M8.5 7V5.4A1.4 1.4 0 0 1 9.9 4h4.2a1.4 1.4 0 0 1 1.4 1.4V7" />
    <path d="M3 12.5h18" />
    <path d="M10.5 12.5v2h3v-2" />
  </Icon>
);

export const UsersIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9.5" cy="8" r="3.4" />
    <path d="M3.2 19.5a6.3 6.3 0 0 1 9.6-5.4" />
    <circle cx="17.5" cy="17" r="2.4" />
    <path d="M17.5 13.2v1.1M17.5 19.7v1.1M20.8 15.1l-1 .5M15.2 18.4l-1 .5M20.8 18.9l-1-.5M15.2 15.6l-1-.5" />
  </Icon>
);

export const DevicesIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="5" width="12.5" height="9.5" rx="1.6" />
    <path d="M6 18h5.5" />
    <path d="M8.7 14.5V18" />
    <rect x="16.5" y="9.5" width="5" height="10" rx="1.4" />
    <path d="M18.5 17.4h1" />
  </Icon>
);

export const CompanyIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 20.5h18" />
    <rect x="4.5" y="3.5" width="10" height="17" rx="1.6" />
    <path d="M14.5 9h4a1.5 1.5 0 0 1 1.5 1.5v10" />
    <path d="M7.5 7h1.5M7.5 10.5h1.5M7.5 14h1.5M11 7h1.5M11 10.5h1.5M11 14h1.5" />
  </Icon>
);

export const StorageIcon = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="5.8" rx="7.5" ry="2.9" />
    <path d="M4.5 5.8v12.4c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9V5.8" />
    <path d="M4.5 12c0 1.6 3.4 2.9 7.5 2.9s7.5-1.3 7.5-2.9" />
  </Icon>
);

/** A sheet of paper with a folded corner — site licences and certificates. */
export const DocumentsIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
    <path d="M14 3v4.5h4.5" />
    <path d="M9 13h6" />
    <path d="M9 16.5h4" />
  </Icon>
);

export const AuditIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
    <path d="M3 4.5v4h4" />
    <path d="M12 7.6V12l3 1.9" />
  </Icon>
);

/* ---- Chrome ---- */

export const MenuIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const CollapseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 18h16M4 12h9" />
    <path d="m20 12-3.5-3v6L20 12Z" />
  </Icon>
);

export const ExpandIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6h16M4 18h16M11 12h9" />
    <path d="m4 12 3.5-3v6L4 12Z" />
  </Icon>
);

export const LogoutIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14.5 4H17a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-2.5" />
    <path d="m9.5 8.5-3.5 3.5 3.5 3.5M6 12h9" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5.5 5.5 13 13M18.5 5.5l-13 13" />
  </Icon>
);

export const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
  </Icon>
);
