'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  AppBar,
  Avatar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import FactCheckOutlinedIcon from '@mui/icons-material/FactCheckOutlined';
import BuildOutlinedIcon from '@mui/icons-material/BuildOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import EngineeringOutlinedIcon from '@mui/icons-material/EngineeringOutlined';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import LocationCityOutlinedIcon from '@mui/icons-material/LocationCityOutlined';
import HandshakeOutlinedIcon from '@mui/icons-material/HandshakeOutlined';
import WorkOutlineOutlinedIcon from '@mui/icons-material/WorkOutlineOutlined';
import ManageAccountsOutlinedIcon from '@mui/icons-material/ManageAccountsOutlined';
import DevicesOutlinedIcon from '@mui/icons-material/DevicesOutlined';
import ApartmentOutlinedIcon from '@mui/icons-material/ApartmentOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import PendingActionsOutlinedIcon from '@mui/icons-material/PendingActionsOutlined';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import MenuIcon from '@mui/icons-material/Menu';
import { Me } from '@/lib/types';
import { navForRole, roleLabel, NavGroup } from '@/lib/rbac';
import { SosBanner } from '@/components/SosBanner';
import { tokens } from '@/theme/theme';

const DRAWER_WIDTH = 248;
const DRAWER_COLLAPSED = 68;

const NAV_ICONS: Record<string, React.ReactNode> = {
  '/': <DashboardOutlinedIcon />,
  '/attendance': <FactCheckOutlinedIcon />,
  '/attendance/fix': <BuildOutlinedIcon />,
  '/corrections': <RuleOutlinedIcon />,
  '/attendance/manual-entries': <PendingActionsOutlinedIcon />,
  '/reports': <AssessmentOutlinedIcon />,
  '/workers': <EngineeringOutlinedIcon />,
  '/staff': <BadgeOutlinedIcon />,
  '/visitors': <GroupsOutlinedIcon />,
  '/sites': <LocationCityOutlinedIcon />,
  '/vendors': <HandshakeOutlinedIcon />,
  '/designations': <WorkOutlineOutlinedIcon />,
  '/users': <ManageAccountsOutlinedIcon />,
  '/devices': <DevicesOutlinedIcon />,
  '/company': <ApartmentOutlinedIcon />,
  '/storage': <StorageOutlinedIcon />,
  '/audit': <HistoryOutlinedIcon />,
};

const GROUP_ORDER: NavGroup[] = [
  'Overview',
  'Operations',
  'People',
  'Sites & partners',
  'Administration',
];

export function AppShell({ me, children }: { me: Me; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const items = navForRole(me.role);
  const [collapsed, setCollapsed] = React.useState(false);
  const [menuAnchor, setMenuAnchor] = React.useState<HTMLElement | null>(null);

  const width = collapsed ? DRAWER_COLLAPSED : DRAWER_WIDTH;
  // Nested routes (/attendance/fix) match their parent too, so the most specific
  // matching item wins — otherwise both it and /attendance would highlight.
  const matches = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href));
  const current = items
    .filter((i) => matches(i.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const active = (href: string) => current?.href === href;

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  }

  const initials = me.fullName
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <Box sx={{ display: 'flex' }}>
      {/* ---------- Sidebar ---------- */}
      <Drawer
        variant="permanent"
        sx={{
          width,
          flexShrink: 0,
          whiteSpace: 'nowrap',
          [`& .MuiDrawer-paper`]: {
            width,
            boxSizing: 'border-box',
            bgcolor: tokens.sidebarBg,
            color: tokens.sidebarText,
            borderRight: 'none',
            overflowX: 'hidden',
            transition: 'width 180ms ease',
          },
          transition: 'width 180ms ease',
        }}
      >
        {/* Brand */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.25,
            px: collapsed ? 1.75 : 2.25,
            py: 2,
          }}
        >
          <Box
            sx={{
              width: 34,
              height: 34,
              borderRadius: 1.5,
              display: 'grid',
              placeItems: 'center',
              flexShrink: 0,
              bgcolor: alpha('#FFFFFF', 0.08),
              border: `1px solid ${alpha('#FFFFFF', 0.14)}`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" style={{ width: 22, height: 22, objectFit: 'contain' }} />
          </Box>
          {!collapsed && (
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ color: '#fff', fontWeight: 700, lineHeight: 1.15, fontSize: 15 }}>
                CLAMS
              </Typography>
              <Typography sx={{ fontSize: 11, color: tokens.sidebarText, letterSpacing: '0.04em' }}>
                SITE ATTENDANCE
              </Typography>
            </Box>
          )}
        </Box>
        <Divider sx={{ borderColor: alpha('#FFFFFF', 0.08) }} />

        {/* Nav groups */}
        <Box sx={{ flexGrow: 1, overflowY: 'auto', overflowX: 'hidden', pt: 1 }}>
          {GROUP_ORDER.map((group) => {
            const groupItems = items.filter((i) => i.group === group);
            if (groupItems.length === 0) return null;
            return (
              <List
                key={group}
                dense
                subheader={
                  !collapsed && group !== 'Overview' ? (
                    <ListSubheader
                      disableSticky
                      sx={{
                        bgcolor: 'transparent',
                        color: alpha('#FFFFFF', 0.35),
                        fontSize: 10.5,
                        fontWeight: 700,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        lineHeight: 2.4,
                        px: 2.25,
                      }}
                    >
                      {group}
                    </ListSubheader>
                  ) : undefined
                }
                sx={{ px: 1, py: 0.25 }}
              >
                {groupItems.map((item) => {
                  const isActive = active(item.href);
                  const btn = (
                    <ListItemButton
                      key={item.href}
                      onClick={() => router.push(item.href)}
                      sx={{
                        borderRadius: 2,
                        mb: 0.25,
                        px: collapsed ? 1.5 : 1.5,
                        justifyContent: collapsed ? 'center' : 'flex-start',
                        color: isActive ? tokens.sidebarActive : tokens.sidebarText,
                        bgcolor: isActive ? alpha('#FFFFFF', 0.1) : 'transparent',
                        '&:hover': { bgcolor: alpha('#FFFFFF', 0.06) },
                        position: 'relative',
                        '&::before': isActive
                          ? {
                              content: '""',
                              position: 'absolute',
                              left: -8,
                              top: 8,
                              bottom: 8,
                              width: 3,
                              borderRadius: 3,
                              bgcolor: tokens.accent,
                            }
                          : undefined,
                      }}
                    >
                      <ListItemIcon
                        sx={{
                          minWidth: collapsed ? 0 : 34,
                          color: 'inherit',
                          '& svg': { fontSize: 19 },
                        }}
                      >
                        {NAV_ICONS[item.href]}
                      </ListItemIcon>
                      {!collapsed && (
                        <ListItemText
                          primary={item.label}
                          primaryTypographyProps={{
                            fontSize: 13.5,
                            fontWeight: isActive ? 650 : 500,
                          }}
                        />
                      )}
                    </ListItemButton>
                  );
                  return collapsed ? (
                    <Tooltip key={item.href} title={item.label} placement="right">
                      {btn}
                    </Tooltip>
                  ) : (
                    btn
                  );
                })}
              </List>
            );
          })}
        </Box>

        {/* Collapse toggle */}
        <Divider sx={{ borderColor: alpha('#FFFFFF', 0.08) }} />
        <Box sx={{ p: 1, display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end' }}>
          <IconButton
            size="small"
            onClick={() => setCollapsed((c) => !c)}
            sx={{ color: tokens.sidebarText }}
            title={collapsed ? 'Expand menu' : 'Collapse menu'}
          >
            {collapsed ? <MenuIcon fontSize="small" /> : <MenuOpenIcon fontSize="small" />}
          </IconButton>
        </Box>
      </Drawer>

      {/* ---------- Main column ---------- */}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar
          position="sticky"
          elevation={0}
          color="transparent"
          sx={{
            bgcolor: alpha('#FFFFFF', 0.85),
            backdropFilter: 'blur(8px)',
            borderBottom: (t) => `1px solid ${t.palette.divider}`,
          }}
        >
          <Toolbar sx={{ minHeight: 60, gap: 2 }}>
            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" noWrap sx={{ lineHeight: 1.2 }}>
                {current?.label ?? 'CLAMS'}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap display="block">
                {new Date().toLocaleDateString(undefined, {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                })}
              </Typography>
            </Box>

            <Box
              onClick={(e) => setMenuAnchor(e.currentTarget)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.25,
                cursor: 'pointer',
                borderRadius: 2,
                px: 1,
                py: 0.5,
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  fontSize: 13,
                  fontWeight: 700,
                  bgcolor: tokens.primary,
                }}
              >
                {initials}
              </Avatar>
              <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
                <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.2 }} noWrap>
                  {me.fullName}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">
                  {roleLabel(me.role)}
                </Typography>
              </Box>
            </Box>
            <Menu
              anchorEl={menuAnchor}
              open={!!menuAnchor}
              onClose={() => setMenuAnchor(null)}
              anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
              transformOrigin={{ vertical: 'top', horizontal: 'right' }}
            >
              <Box sx={{ px: 2, py: 1 }}>
                <Typography variant="body2" sx={{ fontWeight: 650 }}>
                  {me.fullName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {me.email ?? roleLabel(me.role)}
                </Typography>
              </Box>
              <Divider />
              <MenuItem onClick={logout}>
                <ListItemIcon>
                  <LogoutOutlinedIcon fontSize="small" />
                </ListItemIcon>
                Sign out
              </MenuItem>
            </Menu>
          </Toolbar>
        </AppBar>

        {/* minWidth:0 lets the main column shrink so wide content (e.g. report
            tables) scrolls inside its own container instead of widening the page. */}
        <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 } }}>
          <SosBanner />
          {children}
        </Box>
      </Box>
    </Box>
  );
}
