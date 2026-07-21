import { api, ApiError } from '../api';
import { el } from '../dom';
import { toolbar } from '../toolbar';
import type { ImportSummaryDto, LibraryDto } from '../types';

/**
 * Sources → Import — the ytdl-sub `subscriptions.yaml` takeover (D-19): paste the live file,
 * pick the target libraries, and the service seeds Sources idempotently (re-running changes
 * nothing). The same POST /api/v1/import/ytdl-sub the cutover used, as a form.
 */

export async function renderImport(root: HTMLElement, refresh: () => void): Promise<void> {
  const libraries = await api<LibraryDto[]>('/api/v1/libraries');

  root.append(
    toolbar({
      apiPath: '/api/v1/import/ytdl-sub',
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
  content.append(el('div', { class: 'section-h' }, 'Import subscriptions.yaml'));

  const yamlInput = el('textarea', {
    placeholder:
      '__preset__:\n  …\nPlex TV Show by Date:\n  = Documentaries:\n    Defunctland: https://www.youtube.com/@Defunctland',
  });
  const videoSelect = el('select', {});
  const musicSelect = el('select', {});
  musicSelect.append(el('option', { value: '' }, 'none (no music channels)'));
  for (const lib of libraries) {
    if (lib.libraryKind === 'video') {
      videoSelect.append(el('option', { value: lib.id }, `${lib.name} (video)`));
    } else {
      musicSelect.append(el('option', { value: lib.id }, `${lib.name} (music)`));
    }
  }
  const applyPreset = el('input', { type: 'checkbox', id: 'import-apply-preset' });

  const errorLine = el('div', { class: 'form-error' });
  const resultLine = el('p', { class: 'hint' });
  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Import');

  const form = el(
    'form',
    {
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        errorLine.textContent = '';
        resultLine.textContent = '';
        if (yamlInput.value.trim() === '') {
          errorLine.textContent = 'paste the subscriptions.yaml text';
          return;
        }
        if (!videoSelect.value) {
          errorLine.textContent = 'a video library is required';
          return;
        }
        submitBtn.disabled = true;
        void api<ImportSummaryDto>('/api/v1/import/ytdl-sub', {
          method: 'POST',
          body: {
            subscriptionsYaml: yamlInput.value,
            videoLibraryId: videoSelect.value,
            ...(musicSelect.value !== '' ? { musicLibraryId: musicSelect.value } : {}),
            applyPreset: applyPreset.checked,
          },
        })
          .then((summary) => {
            resultLine.textContent =
              `Imported ${summary.channels} channels (${summary.video} video · ${summary.music} music): ` +
              `${summary.created} created, ${summary.updated} updated, ${summary.unchanged} unchanged.`;
            refresh();
          })
          .catch((err: unknown) => {
            errorLine.textContent =
              err instanceof ApiError && err.details !== undefined
                ? `${err.message}: ${JSON.stringify(err.details)}`
                : err instanceof Error
                  ? err.message
                  : String(err);
          })
          .finally(() => {
            submitBtn.disabled = false;
          });
      },
    },
    el(
      'div',
      { class: 'form-grid' },
      el(
        'div',
        { class: 'full field' },
        el('label', {}, 'subscriptions.yaml'),
        yamlInput,
        el('span', { class: 'field-hint' }, 'the estate-shape ytdl-sub file; idempotent re-import'),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Video library'), videoSelect),
      el('div', { class: 'field' }, el('label', {}, 'Music library'), musicSelect),
      el(
        'div',
        { class: 'field checkbox-field' },
        applyPreset,
        el(
          'label',
          { for: 'import-apply-preset' },
          'also apply the file’s __preset__ as the video library’s emit policy',
        ),
      ),
    ),
    el('div', { class: 'form-actions' }, submitBtn, errorLine),
  );

  content.append(el('div', { class: 'form-panel' }, form), resultLine);
}
