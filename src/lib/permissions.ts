import type { Role } from '@prisma/client';

/**
 * Coarse module-level access matrix. Individual API routes may apply finer
 * checks (e.g. "only ADMIN can delete users") on top of this.
 */
export const MODULES = [
  'dashboard',
  'companies',
  'contacts',
  'employees',
  'sales',
  'invoicing',
  'purchasing',
  'inventory',
  'tasks',
  'calendar',
  'inbox',
  'whatsapp',
  'wordpress',
  'automations',
  'settings',
  'users',
] as const;

export type Module = (typeof MODULES)[number];

const MATRIX: Record<Role, Module[]> = {
  ADMIN: [...MODULES],
  SALES: [
    'dashboard',
    'companies',
    'contacts',
    'sales',
    'invoicing',
    'inventory',
    'tasks',
    'calendar',
    'inbox',
    'whatsapp',
    'wordpress',
  ],
  OPERATIONS: [
    'dashboard',
    'companies',
    'contacts',
    'employees',
    'purchasing',
    'inventory',
    'sales',
    'tasks',
    'calendar',
    'inbox',
    'whatsapp',
    'wordpress',
  ],
  ACCOUNTING: [
    'dashboard',
    'companies',
    'contacts',
    'invoicing',
    'purchasing',
    'tasks',
    'calendar',
    'inbox',
  ],
};

export function canAccess(role: Role, module: Module): boolean {
  return MATRIX[role]?.includes(module) ?? false;
}

export function isAdmin(role: Role): boolean {
  return role === 'ADMIN';
}
