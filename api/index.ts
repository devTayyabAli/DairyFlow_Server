import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { connectToDb } from '../src/db.js';

let appPromise: Promise<FastifyInstance> | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      await connectToDb(config.MONGODB_URI, config.MONGODB_DB);
      const app = await buildApp();
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const app = await getApp();

  // Strip /api prefix if rewritten by Vercel so Fastify routes match cleanly
  if (req.url) {
    if (req.url === '/api') {
      req.url = '/';
    } else if (req.url.startsWith('/api/')) {
      req.url = req.url.replace(/^\/api/, '');
    }
  }

  app.server.emit('request', req, res);
}
