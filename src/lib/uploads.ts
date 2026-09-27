import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/** Types accepted by the general document-attachment upload (companies,
 * contacts, etc.) — deliberately broader than ALLOWED_BILL_TYPES since these
 * attachments aren't limited to bills/receipts. */
export const ALLOWED_DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
};

export const MAX_DOCUMENT_FILE_BYTES = 15 * 1024 * 1024;

export function getUploadsDir(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
}

export async function saveUploadedFile(
  subdir: string,
  filename: string,
  data: Buffer
): Promise<string> {
  const dir = path.join(getUploadsDir(), subdir);
  await fs.mkdir(dir, { recursive: true });
  const safeName = `${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const fullPath = path.join(dir, safeName);
  await fs.writeFile(fullPath, data);
  return path.join(subdir, safeName);
}

export async function readStoredFile(storedPath: string): Promise<Buffer> {
  return fs.readFile(path.join(getUploadsDir(), storedPath));
}

export async function deleteStoredFile(storedPath: string): Promise<void> {
  try {
    await fs.unlink(path.join(getUploadsDir(), storedPath));
  } catch {
    // ignore missing file
  }
}
