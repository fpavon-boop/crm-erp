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
  'finance',
  'inventory',
  'tasks',
  'calendar',
  'inbox',
  'whatsapp',
  'wordpress',
  'automations',
  'settings',
  'users',
  'ai',
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
    'ai',
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
    'ai',
  ],
  ACCOUNTING: [
    'dashboard',
    'companies',
    'contacts',
    'invoicing',
    'purchasing',
    'finance',
    'tasks',
    'calendar',
    'inbox',
    'ai',
  ],
};

export function canAccess(role: Role, module: Module): boolean {
  return MATRIX[role]?.includes(module) ?? false;
}

export function isAdmin(role: Role): boolean {
  return role === 'ADMIN';
}
