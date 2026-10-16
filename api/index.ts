import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { FastifyInstance } from 'fastify';

let appPromise: Promise<FastifyInstance> | null = null;

/**
 * Loaded lazily (dynamic imports) so a configuration or database problem becomes a readable,
 * logged error instead of an opaque FUNCTION_INVOCATION_FAILED at module load.
 */
async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    appPromise = (async () => {
      const { config } = await import('../src/config.js');
      const { connectToDb } = await import('../src/db.js');
      const { buildApp } = await import('../src/app.js');
      await connectToDb(config.MONGODB_URI, config.MONGODB_DB);
      const app = await buildApp();
      await app.ready();
      return app;
    })();
    // Do not cache a failed start: the next request retries (e.g. after env vars were fixed).
    appPromise.catch(() => {
      appPromise = null;
    });
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let app: FastifyInstance;
  try {
    app = await getApp();
  } catch (err) {
    // Full detail goes to the deployment logs; the response stays generic.
    console.error('DairyFlow failed to start:', err instanceof Error ? err.message : err);
    res.status(503).json({
      error: {
        code: 'SERVER_NOT_READY',
        message: 'The server is not configured correctly. Check the deployment logs for details.',
      },
    });
    return;
  }

  // Strip /api prefix if rewritten by Vercel so Fastify routes match cleanly
  if (req.url) {
    if (req.url === '/api' || req.url === '/api/') {
      req.url = '/';
    } else if (req.url.startsWith('/api/')) {
      req.url = req.url.replace(/^\/api/, '') || '/';
    }
  }

  app.server.emit('request', req, res);
}
