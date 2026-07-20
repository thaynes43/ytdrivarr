import { z } from 'zod';
import type { ProviderContext, RemediationAction, SourceProvider } from '../contracts';

/**
 * A FULL-capability provider stub for contract-conformance testing (the Peloton-shaped end of the
 * YouTube↔Peloton spread). It declares every capability and implements every hook against the SAME
 * interface as the trivial in-core provider — the seam's compatibility promise. `out_of_process`
 * because it declares `scrape`/`tokenMint` (validateProvider enforces that).
 */
export const fakeFullProvider: SourceProvider = {
  id: 'fake-full',
  kind: 'authenticated-scraper',
  runtime: 'out_of_process',
  capabilities: ['auth', 'scrape', 'tokenMint', 'assets', 'remediation'],
  mediaKinds: ['video', 'music'],
  settingsSchema: z.record(z.string(), z.unknown()),
  scheduling: { mode: 'cron', cron: '0 22 * * *', credentialRefreshSec: 3600 },
  stateNamespace: 'fake-full',

  async test(_ctx: ProviderContext) {
    return {
      status: 'ok' as const,
      checkedAt: new Date().toISOString(),
      credentialAgeSec: 10,
      selectorDriftHits: 0,
    };
  },

  async discover(ctx: ProviderContext) {
    return [
      {
        entryKey: `${ctx.source.ref}#1`,
        displayName: '30 min Bootcamp: 50-50 with Cody Rigsby',
        downloadRef: `${ctx.source.ref}/classes/player/abc123`,
        preset: 'Plex TV Show by Date',
        chip: 'Bike Bootcamp (30 min)',
        overrides: {
          tv_show_directory: '/media/peloton/Bike Bootcamp/Cody Rigsby',
          season_number: 30,
          episode_number: 1,
        },
        ytdlOptions: { http_headers: { Authorization: '${PELOTON_BEARER}' } },
      },
    ];
  },

  async authenticate(_ctx: ProviderContext) {
    return { bearer: 'fake-bearer', cookies: 'fake-cookies', mintedAt: new Date().toISOString() };
  },

  async remediate(entryKey: string, action: RemediationAction, _ctx: ProviderContext) {
    return { entryKey, action, status: 'queued' as const };
  },

  async health(_ctx: ProviderContext) {
    return { status: 'ok' as const, checkedAt: new Date().toISOString(), credentialAgeSec: 10 };
  },

  async describeAssets(_ctx: ProviderContext) {
    return [{ entryKey: 'x', kind: 'thumbnail' as const, ref: 'https://example/thumb.jpg' }];
  },
};
