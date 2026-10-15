import { buildApp } from './app.js';
import { config } from './config.js';
import { closeDb, connectToDb } from './db.js';

async function startServer() {
  try {
    console.log(`Connecting to MongoDB at ${config.MONGODB_URI}/${config.MONGODB_DB}...`);
    await connectToDb(config.MONGODB_URI, config.MONGODB_DB);
    console.log('MongoDB connected successfully and indexes ensured.');

    const app = await buildApp();

    const host = '0.0.0.0';
    const port = config.PORT;

    await app.listen({ port, host });
    console.log(`DairyFlow backend server running on http://${host}:${port}`);

    const shutdown = async (signal: string) => {
      console.log(`Received ${signal}. Shutting down gracefully...`);
      await app.close();
      await closeDb();
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

startServer();
