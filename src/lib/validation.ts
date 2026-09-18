import { z } from 'zod';

export const companySchema = z.object({
  name: z.string().min(1),
  type: z.enum(['CUSTOMER', 'SUPPLIER', 'BOTH', 'PARTNER']).default('CUSTOMER'),
  taxId: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  postalCode: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  phones: z.array(z.object({ label: z.string().default('main'), number: z.string() })).optional(),
  emails: z.array(z.object({ label: z.string().default('main'), address: z.string() })).optional(),
});

export const contactSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email().optional().or(z.literal('')).nullable(),
  phone: z.string().optional().nullable(),
  mobile: z.string().optional().nullable(),
  position: z.string().optional().nullable(),
  companyId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const employeeSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  position: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  hireDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  unit: z.string().default('unit'),
  price: z.coerce.number().default(0),
  cost: z.coerce.number().default(0),
  taxRate: z.coerce.number().default(0),
  trackInventory: z.boolean().default(true),
  reorderPoint: z.coerce.number().default(0),
});

export const warehouseSchema = z.object({
  name: z.string().min(1),
  address: z.string().optional().nullable(),
  isDefault: z.boolean().optional(),
});

const lineItemSchema = z.object({
  productId: z.string().optional().nullable(),
  productVariantId: z.string().optional().nullable(),
  description: z.string().min(1),
  quantity: z.coerce.number().default(1),
  unitPrice: z.coerce.number().default(0),
  taxRate: z.coerce.number().default(0),
  discount: z.coerce.number().default(0),
});

export const quoteSchema = z.object({
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  opportunityId: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED']).default('DRAFT'),
  validUntil: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z.array(lineItemSchema).min(1),
});

export const salesOrderSchema = z.object({
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  quoteId: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'CONFIRMED', 'SHIPPED', 'DELIVERED', 'CANCELLED']).default('DRAFT'),
  notes: z.string().optional().nullable(),
  items: z.array(lineItemSchema).min(1),
});

export const invoiceSchema = z.object({
  type: z.enum(['INVOICE', 'ESTIMATE', 'RECEIPT']).default('INVOICE'),
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  salesOrderId: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED']).default('DRAFT'),
  dueDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z.array(lineItemSchema).min(1),
});

export const purchaseOrderSchema = z.object({
  supplierId: z.string().optional().nullable(),
  status: z
    .enum(['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'])
    .default('DRAFT'),
  expectedDate: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  items: z
    .array(
      z.object({
        productId: z.string().optional().nullable(),
        productVariantId: z.string().optional().nullable(),
        description: z.string().min(1),
        quantity: z.coerce.number().default(1),
        unitCost: z.coerce.number().default(0),
      })
    )
    .min(1),
});

export const supplierInvoiceSchema = z.object({
  number: z.string().min(1),
  supplierId: z.string().optional().nullable(),
  purchaseOrderId: z.string().optional().nullable(),
  amount: z.coerce.number(),
  dueDate: z.string().optional().nullable(),
});

export const opportunitySchema = z.object({
  title: z.string().min(1),
  companyId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  stage: z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']).default('NEW'),
  value: z.coerce.number().default(0),
  probability: z.coerce.number().default(20),
  expectedCloseDate: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export const taskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED']).default('TODO'),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  dueDate: z.string().optional().nullable(),
  assigneeId: z.string().optional().nullable(),
});

export const calendarEventSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  allDay: z.boolean().optional(),
});

export const userSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['ADMIN', 'SALES', 'OPERATIONS', 'ACCOUNTING']),
  password: z.string().min(8).optional(),
  active: z.boolean().optional(),
});

export const automationRuleSchema = z.object({
  name: z.string().min(1),
  trigger: z.enum([
    'EMAIL_RECEIVED_NO_REPLY',
    'INVOICE_OVERDUE',
    'ORDER_PENDING',
    'LOW_STOCK',
    'ORDER_STATUS_CHANGED',
    'INVOICE_CREATED',
    'SCHEDULE',
  ]),
  active: z.boolean().default(true),
  actions: z.array(z.record(z.unknown())).default([]),
  conditions: z.record(z.unknown()).optional(),
});
