/**
 * The operator console is FABLE-built (the division-of-labor ruling, ADR-074 C-14 / DESIGN-045
 * D-20) — Opus builds the service internals only. This is the honest M1 stub: a `/` page that says
 * the console is coming and links the live health surface + the generated OpenAPI. It adds NO
 * capability the REST API lacks.
 */
export const consoleStubHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ytdrivarr</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; }
      code { background: #eee; padding: 0.1rem 0.3rem; border-radius: 0.2rem; }
      a { color: #2563eb; }
    </style>
  </head>
  <body>
    <h1>ytdrivarr</h1>
    <p>The *arr-shaped ytdl-content suite service. The operator console is on its way (built
      separately); the REST API is live now.</p>
    <ul>
      <li><a href="/health">/health</a> — service + per-source health</li>
      <li><a href="/openapi.json">/openapi.json</a> — the generated API spec</li>
    </ul>
    <p>The member-facing experience lives in haynesnetwork, which talks to this service over the
      confined <code>@hnet/ytdl</code> client with an <code>X-Api-Key</code>. Members never touch
      this UI, exactly as they never touch Sonarr's.</p>
  </body>
</html>
`;
