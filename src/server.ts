import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectToDb } from './db.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

let app: FastifyInstance | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})...`);
  // Hard stop if connections refuse to drain.
  setTimeout(() => {
    console.error('Graceful shutdown timed out, forcing exit');
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  try {
    await app?.close();
    await closeDb();
  } catch (err) {
    console.error('Error during shutdown:', err);
    exitCode = exitCode || 1;
  }
  process.exit(exitCode);
}

process.on('SIGINT', () => void shutdown('SIGINT', 0));
process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  void shutdown('uncaughtException', 1);
});

async function startServer() {
  try {
    // Never print credentials embedded in the connection string.
    console.log(`Connecting to MongoDB (db "${config.MONGODB_DB}")...`);
    await connectToDb(config.MONGODB_URI, config.MONGODB_DB);
    console.log('MongoDB connected successfully and indexes ensured.');

    app = await buildApp();
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    await shutdown('startup failure', 1);
  }
}

void startServer();
