'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { cn } from '@/lib/cn';
import { Me } from '@/lib/types';
import { navForRole, roleLabel, NavGroup, NavItem } from '@/lib/rbac';
import { SosBanner } from '@/components/SosBanner';
import { ThemeToggle } from '@/components/ui/ThemeToggle';
import { useColorMode } from '@/theme/ColorModeProvider';
import { tokensFor } from '@/theme/tokens';
import { TOPBAR_H } from '@/lib/layout';
import * as I from '@/components/icons';

/**
 * The panel's frame.
 *
 * Rebuilt on Tailwind, off MUI. Not for its own sake: a Drawer, an AppBar and a
 * Menu bring Material's spacing, its ripple, its elevation curve and its icon
 * set with them, and the result reads as an admin template rather than as this
 * company's product. The frame is the first thing a client sees and the last
 * thing they stop seeing, so it is the piece most worth owning outright.
 *
 * The pages inside are still MUI and stay that way — this is a chrome swap, not
 * a rewrite. Everything here reads the same `--clams-*` tokens the pages do, so
 * the two systems cannot drift apart on colour.
 */

const RAIL_W = 258;
const RAIL_COLLAPSED = 74;
const COLLAPSE_KEY = 'clams.railCollapsed';

const NAV_ICONS: Record<string, React.FC<I.IconProps>> = {
  '/': I.DashboardIcon,
  '/attendance': I.AttendanceIcon,
  '/attendance/fix': I.WrenchIcon,
  '/corrections': I.RuleIcon,
  '/attendance/manual-entries': I.PendingIcon,
  '/reports': I.ReportsIcon,
  '/safety': I.SafetyIcon,
  '/safety/daily': I.DailyTaskIcon,
  '/workers': I.HelmetIcon,
  '/staff': I.BadgeIcon,
  '/visitors': I.VisitorsIcon,
  '/sites': I.SitesIcon,
  '/vendors': I.VendorsIcon,
  '/designations': I.DesignationsIcon,
  '/users': I.UsersIcon,
  '/devices': I.DevicesIcon,
  '/company': I.CompanyIcon,
  '/storage': I.StorageIcon,
  '/audit': I.AuditIcon,
};

const GROUP_ORDER: NavGroup[] = [
  'Overview',
  'Operations',
  'Safety',
  'People',
  'Sites & partners',
  'Administration',
];

/** Matches a CSS media query, without pulling in a UI library to do it. */
function useMediaQuery(query: string) {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setMatches(m.matches);
    sync();
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

interface RailPalette {
  bg: string;
  text: string;
  active: string;
  activeBg: string;
  hover: string;
  rule: string;
  heading: string;
  edge: string;
  accent: string;
}

/**
 * A label for a collapsed nav item.
 *
 * Portalled to the body on purpose. The nav list scrolls, and a scroll
 * container clips its children whatever their position — an in-place tooltip
 * simply disappears at the top and bottom of the rail. A native `title` would
 * dodge that, but an OS tooltip with its own delay and its own styling in the
 * middle of a custom interface is exactly the seam that reads as unfinished.
 */
function RailTip({
  anchor,
  label,
  palette,
}: {
  anchor: DOMRect | null;
  label: string;
  palette: RailPalette;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  if (!mounted || !anchor) return null;

  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-[80] -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold shadow-elevated"
      style={{
        top: anchor.top + anchor.height / 2,
        left: anchor.right + 10,
        background: palette.activeBg === 'transparent' ? palette.bg : palette.bg,
        color: palette.active,
        border: `1px solid ${palette.rule}`,
      }}
    >
      {label}
    </div>,
    document.body,
  );
}

function NavButton({
  item,
  isActive,
  collapsed,
  palette,
  onNavigate,
}: {
  item: NavItem;
  isActive: boolean;
  collapsed: boolean;
  palette: RailPalette;
  onNavigate: (href: string) => void;
}) {
  const Glyph = NAV_ICONS[item.href] ?? I.DashboardIcon;
  const ref = React.useRef<HTMLButtonElement>(null);
  const [tip, setTip] = React.useState<DOMRect | null>(null);

  const openTip = () => {
    if (collapsed && ref.current) setTip(ref.current.getBoundingClientRect());
  };
  const closeTip = () => setTip(null);

  return (
    <>
      <button
        ref={ref}
        type="button"
        onClick={() => onNavigate(item.href)}
        onPointerEnter={openTip}
        onPointerLeave={closeTip}
        onFocus={openTip}
        onBlur={closeTip}
        aria-current={isActive ? 'page' : undefined}
        aria-label={collapsed ? item.label : undefined}
        className={cn(
          'group relative flex w-full items-center rounded-[10px] outline-none transition-colors duration-150',
          // 40px on a pointer, 44 under a finger — the drawer is the touch case.
          'h-10 md:h-10',
          collapsed ? 'justify-center px-0' : 'gap-3 px-3',
          // Hover comes from a custom property rather than a mutated inline
          // style: the rail's colours are values, not utility classes, and
          // writing to element.style fights React for the same slot on every
          // re-render. The active item sets `background` inline, which wins
          // over this — which is what we want, it should not react to hover.
          !isActive && 'hover:bg-[var(--nav-hover)]',
        )}
        style={
          {
            color: isActive ? palette.active : palette.text,
            '--nav-hover': palette.hover,
            ...(isActive ? { background: palette.activeBg } : null),
          } as React.CSSProperties
        }
      >
        {/* The active marker slides between items rather than blinking on and
            off, so the eye can follow where it went. Amber, not brand blue:
            it is the one hi-vis note in the whole frame and it belongs to a
            product about people on a construction site. */}
        {isActive && (
          <motion.span
            layoutId="rail-active"
            aria-hidden
            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r"
            style={{ background: palette.accent }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          />
        )}
        <Glyph className="size-[19px] shrink-0" />
        {!collapsed && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-left text-[13.5px]',
              isActive ? 'font-semibold' : 'font-medium',
            )}
          >
            {item.label}
          </span>
        )}
      </button>
      <RailTip anchor={tip} label={item.label} palette={palette} />
    </>
  );
}

/** The user block in the top bar, and the menu it opens. */
function UserMenu({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [open, setOpen] = React.useState(false);
  const wrap = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials =
    me.fullName
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  return (
    <div ref={wrap} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2.5 rounded-xl px-1.5 py-1 outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-brand/50"
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand text-[12px] font-bold text-ink-onBrand">
          {initials}
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block truncate text-[13px] font-semibold leading-tight text-ink">
            {me.fullName}
          </span>
          <span className="block truncate text-[12px] leading-tight text-ink-muted">
            {roleLabel(me.role)}
          </span>
        </span>
        <I.ChevronDownIcon
          className={cn('hidden size-4 shrink-0 text-ink-faint transition-transform sm:block', open && 'rotate-180')}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-card border border-line bg-surface-elevated shadow-elevated"
          >
            <div className="border-b border-line px-3.5 py-3">
              <p className="truncate text-[13px] font-semibold text-ink">{me.fullName}</p>
              <p className="truncate text-[12px] text-ink-muted">{me.email ?? roleLabel(me.role)}</p>
            </div>
            {/* Signing out is separated from everything else on purpose — it is
                the one item here you cannot undo with the back button. */}
            <button
              type="button"
              role="menuitem"
              onClick={onLogout}
              className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[13px] font-medium text-ink-muted outline-none transition-colors hover:bg-surface-hover hover:text-critical focus-visible:bg-surface-hover"
            >
              <I.LogoutIcon className="size-[17px]" />
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { mode } = useColorMode();
  const reduced = useReducedMotion();
  const c = tokensFor(mode);
  const isDark = mode === 'dark';

  const items = navForRole(me.role);
  const mobile = useMediaQuery('(max-width: 767px)');
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  // Remembered across navigations. A rail that springs back open every time you
  // change page is one nobody collapses twice.
  React.useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);
  const toggleCollapsed = () =>
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      return !v;
    });

  // The overlay covers the page it just navigated to.
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  /**
   * The rail is dark in both colour modes — it is the frame, not the content,
   * and a dark rail against light content is what this panel has always looked
   * like. In dark mode it drops to the page's accent tone so it sits *below*
   * the cards rather than floating above them; in light mode it holds a fixed
   * brand navy that the rest of the palette never uses.
   */
  const palette: RailPalette = isDark
    ? {
        bg: c.bgAccent,
        text: c.textSecondary,
        active: c.textPrimary,
        activeBg: c.surfaceSelected,
        hover: c.surfaceHover,
        rule: c.border,
        heading: c.textMuted,
        edge: c.border,
        accent: c.warning,
      }
    : {
        bg: '#151C28',
        text: '#9AA5B5',
        active: '#FFFFFF',
        activeBg: 'rgba(255,255,255,0.10)',
        hover: 'rgba(255,255,255,0.06)',
        rule: 'rgba(255,255,255,0.09)',
        heading: 'rgba(255,255,255,0.38)',
        edge: 'transparent',
        accent: '#E0A438',
      };

  // Nested routes (/attendance/fix) match their parent too, so the most
  // specific matching item wins — otherwise both it and /attendance highlight.
  const matches = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const current = items
    .filter((i) => matches(i.href))
    .sort((a, b) => b.href.length - a.href.length)[0];

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  const railWidth = collapsed && !mobile ? RAIL_COLLAPSED : RAIL_W;
  const showLabels = !collapsed || mobile;

  // data-shell turns on the scoped native-control reset in tailwind.css. It
  // goes on the chrome only — never on the wrapper around <main>, or the reset
  // would strip the MUI pages' own button and list styling on every route.
  const rail = (
    <div data-shell className="flex h-full flex-col" style={{ background: palette.bg }}>
      {/* ---- Brand ---- */}
      <div
        className={cn('flex shrink-0 items-center gap-2.5 px-4', showLabels ? 'h-[60px]' : 'h-[60px] justify-center px-0')}
        style={{ borderBottom: `1px solid ${palette.rule}` }}
      >
        <span
          className="grid size-9 shrink-0 place-items-center rounded-[10px]"
          style={{
            background: isDark ? 'rgba(110,143,232,0.14)' : 'rgba(255,255,255,0.08)',
            border: `1px solid ${isDark ? palette.rule : 'rgba(255,255,255,0.14)'}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="size-[22px] object-contain" />
        </span>
        {showLabels && (
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-bold leading-tight" style={{ color: palette.active }}>
              CLAMS
            </p>
            <p
              className="text-[11px] font-medium uppercase leading-tight tracking-[0.09em]"
              style={{ color: palette.heading }}
            >
              Site attendance
            </p>
          </div>
        )}
        {mobile && (
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close menu"
            className="grid size-9 shrink-0 place-items-center rounded-lg transition-colors"
            style={{ color: palette.text }}
          >
            <I.CloseIcon className="size-[18px]" />
          </button>
        )}
      </div>

      {/* ---- Nav ---- */}
      <nav aria-label="Main" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-3">
        {GROUP_ORDER.map((group, gi) => {
          const groupItems = items.filter((i) => i.group === group);
          if (groupItems.length === 0) return null;
          return (
            <div key={group} className={cn(gi > 0 && 'mt-1.5 pt-3')}>
              {/* A hairline above each group, not just a heading. Headings alone
                  float; the rule is what makes the rail read as sections. */}
              {gi > 0 && (
                <div
                  aria-hidden
                  className="-mt-3 mb-2.5"
                  style={{ borderTop: `1px solid ${palette.rule}` }}
                />
              )}
              {showLabels && group !== 'Overview' && (
                <p
                  className="mb-1 px-3 text-[11px] font-bold uppercase tracking-[0.11em]"
                  style={{ color: palette.heading }}
                >
                  {group}
                </p>
              )}
              <div className="space-y-0.5">
                {groupItems.map((item) => (
                  <NavButton
                    key={item.href}
                    item={item}
                    isActive={current?.href === item.href}
                    collapsed={!showLabels}
                    palette={palette}
                    onNavigate={(href) => router.push(href)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* ---- Collapse ---- */}
      {!mobile && (
        <div className="shrink-0 p-3" style={{ borderTop: `1px solid ${palette.rule}` }}>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
            className={cn(
              'flex h-9 w-full items-center rounded-[10px] text-[12px] font-semibold transition-colors hover:bg-[var(--nav-hover)]',
              collapsed ? 'justify-center' : 'gap-2.5 px-3',
            )}
            style={{ color: palette.text, '--nav-hover': palette.hover } as React.CSSProperties}
          >
            {collapsed ? <I.ExpandIcon className="size-[18px]" /> : <I.CollapseIcon className="size-[18px]" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Keyboard users should not have to tab the whole rail on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-ink-onBrand"
      >
        Skip to content
      </a>

      {/* ---------- Rail ---------- */}
      {mobile ? (
        <AnimatePresence>
          {drawerOpen && (
            <>
              <motion.div
                className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                onClick={() => setDrawerOpen(false)}
              />
              <motion.aside
                className="fixed inset-y-0 left-0 z-50 w-[258px] shadow-elevated"
                initial={reduced ? false : { x: -280 }}
                animate={{ x: 0 }}
                exit={{ x: -280 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              >
                {rail}
              </motion.aside>
            </>
          )}
        </AnimatePresence>
      ) : (
        <aside
          className="sticky top-0 z-30 h-dvh shrink-0 transition-[width] duration-200 ease-out"
          style={{ width: railWidth, borderRight: `1px solid ${palette.edge}` }}
        >
          {rail}
        </aside>
      )}

      {/* ---------- Main column ---------- */}
      {/* min-w-0 lets the column shrink so wide content (report tables) scrolls
          inside its own container instead of widening the page. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-shell
          className="sticky top-0 z-20 flex shrink-0 items-center gap-3 border-b border-line px-4 backdrop-blur-[10px] md:px-6"
          style={{
            height: TOPBAR_H,
            // Translucent over the page wash rather than a flat bar, so content
            // scrolling underneath stays faintly visible.
            background: isDark ? 'rgba(6,13,19,0.82)' : 'rgba(245,246,248,0.82)',
          }}
        >
          {mobile && (
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open menu"
              className="-ml-1 grid size-9 shrink-0 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <I.MenuIcon className="size-[20px]" />
            </button>
          )}

          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              {current?.label ?? 'CLAMS'}
            </p>
            {/* suppressHydrationWarning: the server formats this in the
                container's timezone (UTC) and the browser in the operator's
                (IST), so for five and a half hours a day the two strings
                genuinely differ. Without this React reports a mismatch and
                drops the whole root to client rendering. */}
            <p className="truncate text-[12px] leading-tight text-ink-muted" suppressHydrationWarning>
              {new Date().toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </p>
          </div>

          <ThemeToggle />
          <UserMenu me={me} onLogout={logout} />
        </header>

        <main id="main" className="min-w-0 flex-1 p-4 md:p-6">
          <SosBanner />
          {children}
        </main>
      </div>
    </div>
  );
}
