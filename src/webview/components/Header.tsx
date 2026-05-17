import { Show, createMemo } from 'solid-js';
import { state } from '../store';
import { getRoleLabel, getSelectionAssistantLabel } from '../utils';
import { t } from '../../shared/i18n';

export function Header() {
  const title = createMemo(() => state.chat?.title || state.fileName || t('common.appName'));
  const assistantLabel = createMemo(() => {
    const selectionLabel = getSelectionAssistantLabel(state.availableProviders, state.currentSelection);
    if (selectionLabel) {
      return selectionLabel;
    }

    const messages = state.chat?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === 'assistant') {
        return getRoleLabel(message);
      }
    }

    return '';
  });

  const subtitle = createMemo(() => {
    const chat = state.chat;
    if (!chat) return '';
    const total = chat.messages.length;
    const parts: string[] = [];
    if (assistantLabel()) parts.push(assistantLabel());
    parts.push(t('header.messageCountSuffix', { count: total }));
    if (state.isBusy) parts.push(t('header.generating'));
    return parts.join(' · ');
  });

  return (
    <header class="header">
      <div class="header-main">
        <h1 id="title" class="title">{title()}</h1>
        <p id="subtitle" class="subtitle">{subtitle()}</p>
      </div>
    </header>
  );
}

export function ErrorBanner() {
  return (
    <section id="errorBanner" classList={{ 'error-banner': true, hidden: !state.error }}>
      {state.error}
    </section>
  );
}
