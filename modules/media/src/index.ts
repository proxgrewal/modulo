import { defineModel, mf } from '@modulo/core';
import { defineModule } from '@modulo/kernel';

/**
 * Media library. Binary storage is a server adapter (local disk in dev, S3 /
 * MinIO in production); this module owns the metadata and the image-URL
 * builder hook (`media.url`) that an imgproxy/CDN module can override.
 */
export const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'application/pdf', 'video/mp4'];
export const MAX_BYTES = 20 * 1024 * 1024;

export default defineModule({
  name: 'media',
  version: '1.0.0',
  label: 'Media library',
  kernel: '^1.0.0',
  required: true,
  category: 'Foundation',
  models: [
    defineModel({
      name: 'media.asset',
      label: 'Asset',
      titleField: 'filename',
      fields: {
        filename: mf.string({ required: true }),
        storage_key: mf.string({ required: true, unique: true, max: 300 }),
        url: mf.string({ required: true, max: 500 }),
        mime: mf.string({ required: true, max: 100 }),
        size: mf.int({ required: true }),
        width: mf.int(),
        height: mf.int(),
        alt: mf.string(),
        folder: mf.string({ default: '', index: true }),
      },
      access: { read: 'auth', create: 'media.upload', update: 'media.upload', delete: 'media.upload' },
    }),
  ],
  permissions: [{ key: 'media.upload', label: 'Upload and manage media' }],
  grants: { editor: ['media.upload'], author: ['media.upload'] },
  hooks: [
    {
      // Default URL builder; resizing/CDN modules wrap this (e.g. imgproxy signatures).
      hook: 'media.url',
      kind: 'filter',
      id: 'default',
      fn: (url: string) => url,
    },
  ],
  routes: [
    {
      method: 'GET',
      path: '/assets',
      surface: 'api',
      permission: 'auth',
      handler: async ({ ctx, query }) => ({ body: await ctx.repo('media.asset').find({ search: query.q, where: query.folder ? { folder: query.folder } : undefined, limit: 200 }) }),
    },
    {
      method: 'PATCH',
      path: '/assets/:id',
      surface: 'api',
      permission: 'media.upload',
      handler: async ({ ctx, params, body }) => {
        const { alt, folder } = (body ?? {}) as any;
        return { body: await ctx.repo('media.asset').update(params.id!, Object.fromEntries(Object.entries({ alt, folder }).filter(([, v]) => v !== undefined))) };
      },
    },
  ],
  editor: { collections: [{ model: 'media.asset', label: 'Media', columns: ['filename', 'mime', 'size', 'created_at'] }] },
});
