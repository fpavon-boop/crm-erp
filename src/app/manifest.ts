import type { MetadataRoute } from 'next';

/** Web app manifest (served at /manifest.webmanifest) for "Add to Home Screen". */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CRM / ERP',
    short_name: 'CRM',
    description: 'Customer, sales, invoicing, inventory, operations and marketing management',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f8fafc',
    theme_color: '#0f172a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
