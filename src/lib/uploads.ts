import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

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
