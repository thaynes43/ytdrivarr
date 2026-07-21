import { api, ApiError } from '../api';
import { el } from '../dom';
import { toolbar } from '../toolbar';
import type { LibraryDto, MediaKind, ProviderDto, SourceDto } from '../types';

/**
 * Sources → Add New — the provider-aware add form. YouTube is the addable provider (URL/handle +
 * library + media kind + genre chip); Peloton's twelve per-activity Sources are MANAGED rows
 * seeded by the migration/import — there is nothing to add, only monitoring to toggle, so the
 * form says exactly that. Settings are validated SERVER-SIDE against the provider's settings
 * schema (the POST /api/v1/sources contract); validation failures land on the reserved error
 * line, never in a dialog.
 */

function describeError(err: unknown): string {
  if (err instanceof ApiError && err.details !== undefined) {
    try {
      return `${err.message}: ${JSON.stringify(err.details)}`;
    } catch {
      return err.message;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  return el(
    'div',
    { class: 'field' },
    el('label', {}, labelText),
    input,
    hint ? el('span', { class: 'field-hint' }, hint) : null,
  );
}

export async function renderAddSource(root: HTMLElement, refresh: () => void): Promise<void> {
  const [libraries, providers] = await Promise.all([
    api<LibraryDto[]>('/api/v1/libraries'),
    api<ProviderDto[]>('/api/v1/providers'),
  ]);
  const youtube = providers.find((p) => p.id === 'youtube');

  root.append(
    toolbar({
      apiPath: '/api/v1/sources',
      actions: [
        {
          label: 'Back to Sources',
          icon: 'play',
          onClick: () => {
            window.location.hash = '#/sources';
          },
        },
      ],
    }),
  );
  const content = el('div', { class: 'content' });
  root.append(content);

  content.append(el('div', { class: 'section-h' }, 'Add New Source'));

  if (!youtube) {
    content.append(
      el('p', { class: 'hint' }, 'The youtube provider is not registered — nothing can be added.'),
    );
    return;
  }

  const nameInput = el('input', { type: 'text', placeholder: 'Channel name' });
  const refInput = el('input', { type: 'text', placeholder: 'https://www.youtube.com/@handle' });
  const kindSelect = el('select', {});
  for (const kind of ['video', 'music'] as MediaKind[]) {
    kindSelect.append(el('option', { value: kind }, kind));
  }
  const librarySelect = el('select', {});
  const chipInput = el('input', { type: 'text', placeholder: 'Documentaries' });

  const syncLibraries = (): void => {
    const kind = kindSelect.value as MediaKind;
    librarySelect.replaceChildren();
    for (const lib of libraries.filter((l) => l.libraryKind === kind)) {
      librarySelect.append(el('option', { value: lib.id }, `${lib.name} (${lib.libraryKind})`));
    }
    if (librarySelect.childElementCount === 0) {
      librarySelect.append(el('option', { value: '' }, `no ${kind} library exists`));
    }
    // Music sources are ungrouped (the provider files them by artist); the chip is a video idiom.
    chipInput.disabled = kind === 'music';
    if (kind === 'music') chipInput.value = '';
  };
  kindSelect.addEventListener('change', syncLibraries);
  syncLibraries();

  const errorLine = el('div', { class: 'form-error' });
  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Add Source');

  const form = el(
    'form',
    {
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        errorLine.textContent = '';
        const displayName = nameInput.value.trim();
        const ref = refInput.value.trim();
        if (displayName === '' || ref === '') {
          errorLine.textContent = 'display name and URL/handle are required';
          return;
        }
        if (librarySelect.value === '') {
          errorLine.textContent = `create a ${kindSelect.value} library first (Settings → Libraries)`;
          return;
        }
        const settings: Record<string, unknown> = {};
        if (!chipInput.disabled && chipInput.value.trim() !== '') {
          settings.chip = chipInput.value.trim();
        }
        submitBtn.disabled = true;
        void api<SourceDto>('/api/v1/sources', {
          method: 'POST',
          body: {
            libraryId: librarySelect.value,
            providerId: youtube.id,
            kind: youtube.kind,
            mediaKind: kindSelect.value,
            displayName,
            ref,
            settings,
            createdBy: 'console',
          },
        })
          .then(() => {
            refresh();
            window.location.hash = '#/sources';
          })
          .catch((err: unknown) => {
            errorLine.textContent = describeError(err);
          })
          .finally(() => {
            submitBtn.disabled = false;
          });
      },
    },
    el(
      'div',
      { class: 'form-grid' },
      field('Display name', nameInput, 'the show/artist name the library files under'),
      field('URL or handle', refInput, 'channel URL, playlist URL, or @handle'),
      field('Media kind', kindSelect, 'video → TV Show by Date · music → YouTube Releases'),
      field('Library', librarySelect),
      field('Genre chip', chipInput, 'the = Genre group in the emitted file (video only)'),
    ),
    el('div', { class: 'form-actions' }, submitBtn, errorLine),
  );

  content.append(
    el('div', { class: 'form-panel' }, el('h2', {}, 'YouTube channel or playlist'), form),
    el(
      'p',
      { class: 'hint' },
      'Peloton activities are managed rows: the twelve disciplines already exist as per-activity ',
      'Sources on the Sources page — toggle their bookmark to monitor or unmonitor, edit a row ',
      'to change its cap. There is nothing to add.',
    ),
  );
}
