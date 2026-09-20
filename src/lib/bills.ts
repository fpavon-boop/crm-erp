import { z } from 'zod';

export const ALLOWED_BILL_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
};

export const MAX_BILL_FILE_BYTES = 15 * 1024 * 1024;

const optionalDate = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || !Number.isNaN(new Date(v).getTime()), 'Invalid date');

/** Fields a person can correct while a bill is waiting for review. */
export const billEditSchema = z.object({
  kind: z.enum(['BILL', 'EXPENSE']).optional(),
  vendor: z.string().max(200).optional().nullable(),
  invoiceNumber: z.string().max(120).optional().nullable(),
  amount: z.coerce.number().nonnegative().optional().nullable(),
  billDate: optionalDate.optional(),
  dueDate: optionalDate.optional(),
  category: z.string().max(80).optional().nullable(),
  paid: z.boolean().optional(),
  paymentMethod: z.string().max(60).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export const billImportRowSchema = billEditSchema.extend({
  amount: z.coerce.number().nonnegative(),
});

export const billImportSchema = z.object({
  rows: z.array(billImportRowSchema).min(1).max(2000),
});
