import type { MobileUser } from './auth-api';

/** UI policy only. The API remains authoritative on every request. */
export function hasModule(user: MobileUser | null, area: 'crm' | 'desk'): boolean {
  return Array.isArray(user?.modules) && user.modules.includes(area);
}

export function canScreen(user: MobileUser | null, screen: string, level: 'view' | 'edit' = 'view'): boolean {
  if (!user || (level !== 'view' && level !== 'edit')) return false;
  if (user.is_admin === true) return true;
  const grant = user.permissions && Object.hasOwn(user.permissions, screen) ? user.permissions[screen] : 'none';
  return grant === 'edit' || (level === 'view' && grant === 'view');
}

export function canAreaScreen(user: MobileUser | null, area: 'crm' | 'desk', screen: string, level: 'view' | 'edit' = 'view'): boolean {
  return hasModule(user, area) && canScreen(user, screen, level);
}

export function requireAreaEdit(user: MobileUser | null, area: 'crm' | 'desk', screen: string): void {
  if (!canAreaScreen(user, area, screen, 'edit')) throw new Error('You do not have permission to edit this screen.');
}
