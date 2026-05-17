import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { state, actions } from '../store';
import type { WebviewConfigFieldKey } from '../../shared/protocol';
import { t } from '../../shared/i18n';

const VARIABLE_HINT_KEY = 'config.variableHint';

function getCommonConfigOptionById(configId?: string) {
  if (!configId) return null;
  return state.commonConfig.options.find((option) => option.id === configId) ?? null;
}

function getDraftConfigFieldView(fieldKey: WebviewConfigFieldKey) {
  const draft = state.configDrafts[fieldKey];
  const savedState = state.configFields[fieldKey];
  const inheritedConfigId = state.commonConfig.selectedId || savedState.inheritedConfigId || '';
  const inheritedOption = getCommonConfigOptionById(inheritedConfigId);
  const inheritedValue = inheritedOption
    ? (fieldKey === 'systemPrompt' ? inheritedOption.systemPrompt : inheritedOption.messageTemplate) || ''
    : '';

  let source: 'common-config' | 'local' | 'none' = 'none';
  if (draft.inherit && inheritedValue) {
    source = 'common-config';
  } else if (!draft.inherit && draft.content) {
    source = 'local';
  }

  return {
    inherit: draft.inherit,
    effectiveContent: draft.inherit ? inheritedValue : draft.content,
    source,
    inheritedConfigId,
    inheritedConfigName: inheritedOption?.name || '',
    missingInheritedConfig: Boolean(draft.inherit && inheritedConfigId && !inheritedOption),
    missingInheritedValue: Boolean(draft.inherit && inheritedOption && !inheritedValue),
    hasRetainedDraft: Boolean(draft.inherit && draft.content)
  };
}

function getConfigFieldShortSource(view: ReturnType<typeof getDraftConfigFieldView>) {
  if (view.source === 'common-config') return t('config.sourceFollowing');
  if (view.source === 'local') return t('config.sourceLocal');
  if (view.inherit) return t('config.sourceFollowingEmpty');
  return t('config.sourceNone');
}

function getCommonConfigMenuLabel() {
  const cc = state.commonConfig;
  if (cc.hasMissingSelection && cc.selectedId) {
    return t('config.missingSelectionMenuLabel', { name: cc.selectedName ?? t('common.unknown'), id: cc.selectedId });
  }

  const option = getCommonConfigOptionById(cc.selectedId);
  if (option) {
    return t('config.namedOption', { name: option.name, id: option.id });
  }

  return t('config.noCommonConfig');
}

function CommonConfigMenu(props: { disabled: boolean }) {
  const [isOpen, setIsOpen] = createSignal(false);
  const selectedId = createMemo(() => state.commonConfig.selectedId ?? '');
  const optionItems = createMemo(() => {
    const items = [{ id: '', label: t('config.noCommonConfig'), missing: false }];

    for (const option of state.commonConfig.options) {
      items.push({ id: option.id, label: t('config.namedOption', { name: option.name, id: option.id }), missing: false });
    }

    if (state.commonConfig.hasMissingSelection && state.commonConfig.selectedId) {
      items.push({
        id: state.commonConfig.selectedId,
        label: t('config.missingSelectionMenuLabel', { name: state.commonConfig.selectedName ?? t('common.unknown'), id: state.commonConfig.selectedId }),
        missing: true
      });
    }

    return items;
  });

  let rootRef: HTMLDivElement | undefined;
  const closeMenu = () => setIsOpen(false);

  onMount(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!isOpen()) return;
      if (rootRef?.contains(event.target as Node)) return;
      closeMenu();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isOpen()) {
        event.preventDefault();
        closeMenu();
      }
    };

    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  createEffect(() => {
    if (props.disabled) {
      closeMenu();
    }
  });

  return (
    <div ref={(el) => (rootRef = el)} class="chat-config-select-shell">
      <button
        id="commonConfigSelect"
        type="button"
        classList={{
          'chat-config-select': true,
          'chat-config-select-trigger': true,
          'is-open': isOpen()
        }}
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return;
          setIsOpen((open) => !open);
        }}
      >
        <span class="chat-config-select-label">{getCommonConfigMenuLabel()}</span>
        <span class="chat-config-select-icon codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      <Show when={isOpen()}>
        <div class="chat-config-select-menu">
          <div class="model-menu-list">
            <For each={optionItems()}>
              {(item) => (
                <button
                  type="button"
                  classList={{
                    'model-menu-item': true,
                    'chat-config-select-option': true,
                    'is-selected': selectedId() === item.id,
                    'is-missing': item.missing
                  }}
                  onClick={() => {
                    actions.setCommonConfigId(item.id || null);
                    closeMenu();
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function summaryLine(): string {
  const cc = state.commonConfig;
  const sysPrompt = getDraftConfigFieldView('systemPrompt');
  const msgTpl = getDraftConfigFieldView('messageTemplate');
  const ccName = cc.selectedName?.trim();
  const ccPart = cc.hasMissingSelection
    ? t('config.summaryCommonMissing', { id: cc.selectedId ?? t('common.unknown') })
    : ccName
      ? t('config.summaryCommonActive', { name: ccName })
      : t('config.summaryCommonNone');
  const sysPart = t('config.summarySysPrompt', { value: getConfigFieldShortSource(sysPrompt) });
  const tplPart = t('config.summaryMsgTpl', { value: getConfigFieldShortSource(msgTpl) });
  return `${ccPart} · ${sysPart} · ${tplPart}`;
}

interface FieldConfig {
  key: WebviewConfigFieldKey;
  titleKey: string;
  placeholderKey: string;
  isTemplate?: boolean;
}

const FIELDS: FieldConfig[] = [
  {
    key: 'systemPrompt',
    titleKey: 'config.systemPromptTitle',
    placeholderKey: 'config.systemPromptPlaceholder'
  },
  {
    key: 'messageTemplate',
    titleKey: 'config.messageTemplateTitle',
    placeholderKey: 'config.messageTemplatePlaceholder',
    isTemplate: true
  }
];

function FieldCard(props: { config: FieldConfig; locked: boolean }) {
  const key = () => props.config.key;
  const draft = () => state.configDrafts[key()];
  const view = createMemo(() => getDraftConfigFieldView(key()));
  const effective = () => view().effectiveContent;
  const sourceText = createMemo(() => {
    const s = view();
    if (s.missingInheritedConfig) return t('config.inheritedConfigMissing', { id: s.inheritedConfigId ?? '' });
    if (s.inherit) {
      const name = s.inheritedConfigName?.trim();
      if (s.missingInheritedValue) {
        return name ? t('config.inheritedFieldMissingNamed', { name }) : t('config.inheritedFieldMissing');
      }
      return name ? t('config.usingInheritedNamed', { name }) : t('config.usingInheritedUnnamed');
    }
    if (s.source === 'local') return t('config.localContent');
    return t('config.sourceNone');
  });
  const isWarning = () => view().missingInheritedConfig || (view().inherit && view().missingInheritedValue);

  return (
    <section class="chat-config-card">
      <div class="chat-config-card-header">
        <div>
          <h2 class="chat-config-section-title">{t(props.config.titleKey)}</h2>
          <p class="chat-config-section-subtitle" classList={{ 'is-warning': isWarning() }}>{sourceText()}</p>
        </div>
        <label class="chat-config-toggle">
          <input
            type="checkbox"
            checked={draft().inherit}
            disabled={props.locked}
            onChange={(e) => {
              const nextInherit = e.currentTarget.checked;
              actions.setDraft(key(), { inherit: nextInherit });
              actions.saveDraft(key());
            }}
          />
          <span>{t('config.inheritToggle')}</span>
        </label>
      </div>
      <textarea
        class="chat-config-textarea"
        rows={8}
        placeholder={t(props.config.placeholderKey)}
        value={draft().content}
        disabled={props.locked || draft().inherit}
        onInput={(e) => actions.setDraft(key(), { content: e.currentTarget.value })}
      />
      <div class="chat-config-actions">
        <button class="toolbar-button" type="button" disabled={props.locked || !draft().dirty} onClick={() => actions.resetDraft(key())}>
          {t('common.restore')}
        </button>
        <button
          class="toolbar-button"
          classList={{ 'toolbar-button-active': draft().dirty }}
          type="button"
          disabled={props.locked || !draft().dirty}
          onClick={() => actions.saveDraft(key())}
        >
          {t('common.save')}
        </button>
      </div>
      <p class="chat-config-meta" classList={{ 'is-warning': isWarning() }}>
        <Show when={view().hasRetainedDraft}>{t('config.retainedDraftHint')}</Show>
        <Show when={props.config.isTemplate}>{t(VARIABLE_HINT_KEY)}</Show>
      </p>
      <div class="chat-config-preview">
        <p class="chat-config-preview-label">{t('config.previewLabel')}</p>
        <pre class="chat-config-preview-content" classList={{ 'is-empty': !effective() }}>
          {effective() || t('config.previewEmpty')}
        </pre>
      </div>
    </section>
  );
}

export function ConfigPanel() {
  const commonConfig = () => state.commonConfig;
  const isLocked = createMemo(() => state.isBusy || state.pendingSubmission !== null);
  const meta = createMemo(() => {
    const cc = commonConfig();
    if (cc.hasMissingSelection) return t('config.metaMissing', { id: cc.selectedId ?? '' });
    if (cc.selectedId && cc.selectedName) return t('config.metaActive', { name: cc.selectedName, id: cc.selectedId });
    return t('config.metaNone');
  });

  return (
    <details id="chatConfigPanel" class="chat-config-panel">
      <summary class="chat-config-summary">
        <div class="chat-config-summary-copy">
          <span class="chat-config-summary-label">{t('config.panelTitle')}</span>
          <span id="chatConfigSummaryText" class="chat-config-summary-text">{summaryLine()}</span>
        </div>
        <span class="chat-config-summary-icon codicon codicon-chevron-down" aria-hidden="true" />
      </summary>
      <div class="chat-config-panel-body">
        <section class="chat-config-section">
          <div class="chat-config-section-header">
            <div>
              <h2 class="chat-config-section-title">{t('config.commonConfigSection')}</h2>
              <p class="chat-config-section-subtitle">{t('config.commonConfigSectionDesc')}</p>
            </div>
            <button class="toolbar-button" type="button" disabled={isLocked()} onClick={() => actions.manageCommonConfig()}>
              {t('config.manageCommonConfig')}
            </button>
          </div>
          <label class="chat-config-field-label" for="commonConfigSelect">{t('config.selectedCommonConfigLabel')}</label>
          <CommonConfigMenu disabled={isLocked()} />
          <p id="commonConfigMeta" class="chat-config-meta" classList={{ 'is-warning': commonConfig().hasMissingSelection }}>
            {meta()}
          </p>
        </section>
        <div class="chat-config-field-grid">
          <For each={FIELDS}>{(f) => <FieldCard config={f} locked={isLocked()} />}</For>
        </div>
      </div>
    </details>
  );
}
