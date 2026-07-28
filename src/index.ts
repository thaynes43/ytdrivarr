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
    emitWindowDays: config.emitWindowDays,
  };
  const app = createApp(appOptions);

  // Two clocks, split from the downloader crons (D-15). Each provider's scheduled tick is scoped to
  // that provider (scope='provider'): YouTube's daily safety cron re-emits ONLY YouTube sources, and
  // Peloton's nightly cron stays the SOLE Peloton scrape — so a YouTube tick never drags a Peloton
  // login/scrape (the daily-double-login account-risk bug). Manual/API runs still use scope='all'.
  const scheduler = new Scheduler(logger);
  for (const provider of listProviders()) {
    scheduler.register(provider.id, provider.scheduling, async () => {
      await runDiscovery({
        scope: 'provider',
        providerId: provider.id,
        trigger: 'cron',
        ...(config.projectionRoot !== undefined ? { projectionRoot: config.projectionRoot } : {}),
        emitWindowDays: config.emitWindowDays,
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
