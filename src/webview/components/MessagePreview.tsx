import { For, createMemo, createEffect, Show } from 'solid-js';
import { state, actions, isCompact } from '../store';
import { getMessagePreviewSummary, getRoleLabel, getMessageAnchorId } from '../utils';
import { t } from '../../shared/i18n';

export function MessagePreview() {
  const messages = createMemo(() => state.chat?.messages ?? []);
  const hasMessages = createMemo(() => messages().length > 0);
  let listRef: HTMLDivElement | undefined;

  // 激活项变化时，仅在预览列表内部滚动以让其可见（避免触发外层页面滚动）
  createEffect(() => {
    const id = state.activePreviewMessageId;
    if (!id || !listRef) return;
    const el = listRef.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null;
    if (!el) return;
    const listRect = listRef.getBoundingClientRect();
    const itemRect = el.getBoundingClientRect();
    if (itemRect.top < listRect.top) {
      listRef.scrollTop += itemRect.top - listRect.top - 4;
    } else if (itemRect.bottom > listRect.bottom) {
      listRef.scrollTop += itemRect.bottom - listRect.bottom + 4;
    }
  });

  // Visibility rules:
  // - hidden entirely when no messages
  // - on compact viewport: hidden unless isMessagePreviewOpen=true (is-open)
  // - on non-compact: always visible alongside chat
  // For 'isCompactMessagePreviewViewport' the original always returns true, so we mirror that.
  return (
    <aside
      id="messagePreviewAside"
      classList={{
        'message-preview': true,
        hidden: !hasMessages(),
        'is-open': hasMessages() && state.isMessagePreviewOpen
      }}
      aria-label={t('preview.asideLabel')}
      aria-hidden={!hasMessages() || !state.isMessagePreviewOpen}
    >
      <div class="message-preview-header">
        <p class="message-preview-title">
          <span class="message-preview-title-icon codicon codicon-list-tree" aria-hidden="true" />
          <span>{t('preview.title')}</span>
        </p>
        <p id="messagePreviewCount" class="message-preview-count">{t('preview.countSuffix', { count: messages().length })}</p>
      </div>
      <div ref={(el) => (listRef = el)} id="messagePreviewList" class="message-preview-list">
        <For each={messages()}>
          {(m) => {
            const isActive = createMemo(() => state.activePreviewMessageId === m.id);
            return (
              <a
                href={`#${getMessageAnchorId(m.id)}`}
                classList={{
                  'message-preview-item': true,
                  [`is-${m.role}`]: true,
                  'is-pending': m.status === 'pending',
                  'is-error': m.status === 'error',
                  'is-canceled': m.status === 'canceled',
                  'is-active': isActive()
                }}
                aria-current={isActive() ? 'true' : 'false'}
                data-message-id={m.id}
                title={t('preview.rolePreviewTooltip', { role: getRoleLabel(m), summary: getMessagePreviewSummary(m) })}
                onClick={() => {
                  actions.setAutoFollow(false);
                  actions.setActivePreviewMessageId(m.id);
                  // browser handles scroll via href anchor
                }}
              >
                <span class="message-preview-item-role">{getRoleLabel(m)}</span>
                <span class="message-preview-item-summary">{getMessagePreviewSummary(m)}</span>
              </a>
            );
          }}
        </For>
      </div>
    </aside>
  );
}
