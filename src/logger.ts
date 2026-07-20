import pino, { type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'ytdrivarr' },
});
