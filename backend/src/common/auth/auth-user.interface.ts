import { UserRole } from '../../common/enums';

export interface AuthUser {
  userId: string;
  organizationId: string;
  role: UserRole;
  email?: string | null;
  /** Site IDs in scope; empty for SUPER_ADMIN (means all). */
  siteScopes: string[];
}

/** JWT access-token payload. */
export interface JwtPayload {
  sub: string;
  org: string;
  role: UserRole;
  email?: string | null;
  scopes: string[];
}
