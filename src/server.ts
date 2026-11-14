import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';
import { initRealtime } from './realtime/realtime';

async function main() {
  await prisma.$connect();
  const server = http.createServer(createApp());
  initRealtime(server);

  server.listen(env.PORT, () => {
    console.log(`Café POS API listening on http://localhost:${env.PORT}/api/v1 (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string) => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
