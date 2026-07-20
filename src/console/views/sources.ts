import { api, ApiError } from '../api';
import { createConfirmButton } from '../confirm-button';
import { el, emptyState, errorBanner, kindChip, pageHeader } from '../dom';
import type { LibraryDto, ProviderDto, SourceDto } from '../types';

/**
 * Sources — the full source list across Libraries, with add/edit/remove/enable at the OPERATOR
 * grain (DESIGN-045 D-20: an admin managing the service directly, like editing series in Sonarr).
 * Member-facing add/edit lives app-side (D-18); this surface is API-key-scoped.
 */

interface SourceFormValues {
  libraryId: string;
  providerId: string;
  kind: string;
  mediaKind: string;
  displayName: string;
  ref: string;
  settings: Record<string, unknown>;
  enabled: boolean;
}

function parseSettings(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('settings must be valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

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

function select(
  name: string,
  options: { value: string; label: string }[],
  selected?: string,
): HTMLSelectElement {
  const node = el('select', { name });
  for (const opt of options) {
    const o = el('option', { value: opt.value }, opt.label);
    if (opt.value === selected) o.selected = true;
    node.append(o);
  }
  return node;
}

function textInput(name: string, value = '', placeholder = ''): HTMLInputElement {
  const node = el('input', { name, type: 'text', placeholder });
  node.value = value;
  return node;
}

/** A shared form panel for add + edit — the sanctioned in-place expansion. */
function sourceForm(opts: {
  title: string;
  libraries: LibraryDto[];
  providers: ProviderDto[];
  initial?: SourceDto;
  submitLabel: string;
  onCancel: () => void;
  onSubmit: (values: SourceFormValues) => Promise<void>;
}): HTMLElement {
  const { libraries, providers, initial } = opts;
  const isEdit = initial !== undefined;

  const libraryField = select(
    'libraryId',
    libraries.map((l) => ({ value: l.id, label: `${l.name} (${l.libraryKind})` })),
    initial?.libraryId,
  );
  const providerField = select(
    'providerId',
    providers.map((p) => ({ value: p.id, label: `${p.id} (${p.runtime})` })),
    initial?.providerId,
  );
  const kindField = textInput('kind', initial?.kind ?? providers[0]?.kind ?? '', 'url-list');
  const mediaKindField = select(
    'mediaKind',
    [
      { value: 'video', label: 'video' },
      { value: 'music', label: 'music' },
    ],
    initial?.mediaKind ?? 'video',
  );
  const nameField = textInput('displayName', initial?.displayName ?? '', 'Channel name');
  const refField = textInput('ref', initial?.ref ?? '', 'https://www.youtube.com/@…');
  const settingsField = el('textarea', { name: 'settings' });
  settingsField.value =
    initial && Object.keys(initial.settings).length > 0
      ? JSON.stringify(initial.settings, null, 2)
      : '';
  settingsField.placeholder = '{ "chip": "Documentaries" }';
  const enabledField = el('input', { type: 'checkbox', id: `enabled-${initial?.id ?? 'new'}` });
  enabledField.checked = initial?.enabled ?? true;

  // Picking a provider prefills `kind` with the provider's declared source class (add only).
  providerField.addEventListener('change', () => {
    const p = providers.find((x) => x.id === providerField.value);
    if (p && !isEdit) kindField.value = p.kind;
  });

  const errorLine = el('div', { class: 'form-error' });
  const submitBtn = el('button', { class: 'btn btn-primary', type: 'submit' }, opts.submitLabel);

  const form = el(
    'form',
    {
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        errorLine.textContent = '';
        let settings: Record<string, unknown>;
        try {
          settings = parseSettings(settingsField.value);
        } catch (err) {
          errorLine.textContent = describeError(err);
          return;
        }
        submitBtn.disabled = true;
        void opts
          .onSubmit({
            libraryId: libraryField.value,
            providerId: providerField.value,
            kind: kindField.value.trim(),
            mediaKind: mediaKindField.value,
            displayName: nameField.value.trim(),
            ref: refField.value.trim(),
            settings,
            enabled: enabledField.checked,
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
      field('Library', libraryField),
      field('Provider', providerField),
      field('Kind', kindField, 'the provider-declared source class'),
      field('Media kind', mediaKindField, 'selects the preset family (video | music)'),
      field('Display name', nameField),
      field('Ref', refField, 'the provider-specific handle (URL, channel, discipline)'),
      el(
        'div',
        { class: 'full' },
        field('Settings (JSON)', settingsField, 'validated against the provider settings schema'),
      ),
      el(
        'div',
        { class: 'field checkbox-field' },
        enabledField,
        el('label', { for: enabledField.id }, 'Enabled'),
      ),
    ),
    el(
      'div',
      { class: 'form-actions' },
      submitBtn,
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: opts.onCancel }, 'Cancel'),
      errorLine,
    ),
  );

  return el('div', { class: 'form-panel' }, el('h2', {}, opts.title), form);
}

export async function renderSources(root: HTMLElement, refresh: () => void): Promise<void> {
  const [sources, libraries, providers] = await Promise.all([
    api<SourceDto[]>('/api/v1/sources'),
    api<LibraryDto[]>('/api/v1/libraries'),
    api<ProviderDto[]>('/api/v1/providers'),
  ]);
  const libraryName = new Map(libraries.map((l) => [l.id, l.name]));

  const addBtn = el('button', { class: 'btn btn-primary', type: 'button' }, 'Add source');
  root.append(pageHeader('Sources', '/api/v1/sources', addBtn));

  const addSlot = el('div', {});
  root.append(addSlot);
  addBtn.addEventListener('click', () => {
    if (addSlot.firstChild) {
      addSlot.replaceChildren();
      return;
    }
    if (libraries.length === 0) {
      addSlot.replaceChildren(
        errorBanner('a source needs a library — create one first (POST /api/v1/libraries)'),
      );
      return;
    }
    addSlot.replaceChildren(
      sourceForm({
        title: 'Add source',
        libraries,
        providers,
        submitLabel: 'Add source',
        onCancel: () => addSlot.replaceChildren(),
        onSubmit: async (v) => {
          await api('/api/v1/sources', {
            method: 'POST',
            body: {
              libraryId: v.libraryId,
              providerId: v.providerId,
              kind: v.kind,
              mediaKind: v.mediaKind,
              displayName: v.displayName,
              ref: v.ref,
              settings: v.settings,
              enabled: v.enabled,
            },
          });
          refresh();
        },
      }),
    );
  });

  if (sources.length === 0) {
    root.append(
      emptyState(
        'No sources yet.',
        'Add one above, or POST /api/v1/sources — this list mirrors the API exactly.',
      ),
    );
    return;
  }

  const tbody = el('tbody', {});
  for (const source of sources) {
    const row = el(
      'tr',
      {},
      el('td', {}, source.displayName),
      el('td', {}, libraryName.get(source.libraryId) ?? source.libraryId),
      el('td', { class: 'mono' }, source.providerId),
      el('td', {}, kindChip(source.mediaKind)),
      el('td', { class: 'mono' }, source.ref),
    );

    const toggle = el(
      'button',
      { class: 'btn btn-ghost toggle-btn', type: 'button', 'data-enabled': String(source.enabled) },
      el('span', { class: 'toggle-label toggle-on' }, 'enabled'),
      el('span', { class: 'toggle-label toggle-off' }, 'disabled'),
    );
    toggle.addEventListener('click', () => {
      toggle.disabled = true;
      void api(`/api/v1/sources/${source.id}`, {
        method: 'PATCH',
        body: { enabled: toggle.getAttribute('data-enabled') !== 'true' },
      })
        .then(() => refresh())
        .catch(() => {
          toggle.disabled = false;
        });
    });
    row.append(el('td', {}, toggle));

    const editorSlot = el('tr', { class: 'editor-row' });
    const editBtn = el('button', { class: 'btn btn-ghost', type: 'button' }, 'Edit');
    editBtn.addEventListener('click', () => {
      if (editorSlot.firstChild) {
        editorSlot.replaceChildren();
        return;
      }
      const cell = el('td', { colspan: '7' });
      cell.append(
        sourceForm({
          title: `Edit ${source.displayName}`,
          libraries,
          providers,
          initial: source,
          submitLabel: 'Save changes',
          onCancel: () => editorSlot.replaceChildren(),
          onSubmit: async (v) => {
            await api(`/api/v1/sources/${source.id}`, {
              method: 'PATCH',
              body: {
                displayName: v.displayName,
                ref: v.ref,
                mediaKind: v.mediaKind,
                settings: v.settings,
                enabled: v.enabled,
              },
            });
            refresh();
          },
        }),
      );
      editorSlot.replaceChildren(cell);
    });

    const removeBtn = createConfirmButton({
      label: 'Remove',
      armedLabel: 'Confirm remove',
      onConfirm: async () => {
        await api(`/api/v1/sources/${source.id}`, { method: 'DELETE' });
        refresh();
      },
    });

    row.append(el('td', {}, el('div', { class: 'cell-actions' }, editBtn, removeBtn)));
    tbody.append(row, editorSlot);
  }

  root.append(
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Name'),
            el('th', {}, 'Library'),
            el('th', {}, 'Provider'),
            el('th', {}, 'Media'),
            el('th', {}, 'Ref'),
            el('th', {}, 'State'),
            el('th', {}, ''),
          ),
        ),
        tbody,
      ),
    ),
  );
}
