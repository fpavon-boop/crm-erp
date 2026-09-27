import type { Role, RelatedEntityType } from '@prisma/client';

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

/** Maps a Document/Note's `entityType` to the module that gates access to
 * the record it's attached to, so an attachment is only as visible as its
 * parent record. */
export function moduleForEntityType(entityType: RelatedEntityType): Module {
  switch (entityType) {
    case 'COMPANY':
    case 'CONTACT':
      return 'companies';
    case 'OPPORTUNITY':
    case 'QUOTE':
    case 'SALES_ORDER':
      return 'sales';
    case 'INVOICE':
      return 'invoicing';
    case 'PURCHASE_ORDER':
      return 'purchasing';
    case 'SUPPLIER_INVOICE':
      return 'finance';
    case 'PRODUCT':
      return 'inventory';
    case 'TASK':
      return 'tasks';
    default:
      return 'settings';
  }
}
