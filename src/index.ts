import { serve } from '@hono/node-server';
import { loadConfig } from './config';
import { logger } from './logger';
import { listProviders, loadRegistry } from './core/registry';
import { runMigrations } from './db/migrate';
import { createApp, type CreateAppOptions } from './api/app';
import { Scheduler } from './core/scheduler';
import { runDiscovery } from './core/discovery';

async function main(): Promise<void> {
  const config = loadConfig();

  // A provider that fails to load is a STARTUP ERROR, never a silent skip (D-04).
  loadRegistry();
  logger.info({ providers: listProviders().map((p) => p.id) }, 'provider registry loaded');

  if (config.databaseUrl && !config.skipMigrate) {
    await runMigrations({ databaseUrl: config.databaseUrl });
    logger.info('migrations applied');
  } else if (!config.databaseUrl) {
    logger.warn('DATABASE_URL not set — starting without a database (reads/health will error)');
  }

  const appOptions: CreateAppOptions = {
    apiKeys: config.apiKeys,
    authMode: config.authMode,
    ...(config.projectionRoot !== undefined ? { projectionRoot: config.projectionRoot } : {}),
    ...(config.credentialRoot !== undefined ? { credentialRoot: config.credentialRoot } : {}),
    jobHeartbeatExpirySec: config.jobHeartbeatExpirySec,
    jobMaxAttempts: config.jobMaxAttempts,
  };
  const app = createApp(appOptions);

  // Two clocks, split from the downloader crons (D-15). M1 providers are event-driven, so this
  // registers little; the Peloton nightly cron + bearer SLA arrive with M3.
  const scheduler = new Scheduler(logger);
  for (const provider of listProviders()) {
    scheduler.register(provider.id, provider.scheduling, async () => {
      await runDiscovery({
        scope: 'all',
        trigger: 'cron',
        ...(config.projectionRoot !== undefined ? { projectionRoot: config.projectionRoot } : {}),
      });
    });
  }
  logger.info({ scheduled: scheduler.size }, 'scheduler registered');

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'ytdrivarr listening');
  });

  const shutdown = (): void => {
    scheduler.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => {
  logger.error({ err }, 'ytdrivarr failed to start');
  process.exit(1);
});
