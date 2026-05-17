import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { state, actions } from '../store';
import { copyImageElement } from '../dom';
import { t } from '../../shared/i18n';

export function ImageLightbox() {
  const [copying, setCopying] = createSignal(false);
  const [feedback, setFeedback] = createSignal('');
  let imgRef: HTMLImageElement | undefined;
  let closeBtnRef: HTMLButtonElement | undefined;

  async function onCopy() {
    if (!imgRef || copying()) return;
    setCopying(true);
    setFeedback('');
    try {
      await copyImageElement(imgRef);
      setFeedback(t('lightbox.copied'));
      window.setTimeout(() => setFeedback(''), 1600);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setCopying(false);
    }
  }

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.activeImagePreview) {
        e.preventDefault();
        actions.closeImagePreview();
      }
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  return (
    <Show when={state.activeImagePreview}>
      {(preview) => {
        window.requestAnimationFrame(() => closeBtnRef?.focus());
        return (
        <div
          id="imagePreviewOverlay"
          class="image-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.currentTarget === e.target) actions.closeImagePreview();
          }}
        >
          <div class="image-lightbox-panel" onClick={(e) => e.stopPropagation()}>
            <div class="image-lightbox-toolbar">
              <div class="image-lightbox-meta">
                <p id="imagePreviewTitle" class="image-lightbox-title">{preview().alt?.trim() || t('lightbox.defaultTitle')}</p>
                <p id="imagePreviewDetail" class="image-lightbox-detail">{preview().relativePath?.trim() || t('lightbox.defaultDetail')}</p>
              </div>
              <div class="image-lightbox-actions">
                <button
                  id="copyImageButton"
                  type="button"
                  class="image-lightbox-button"
                  disabled={copying()}
                  onClick={onCopy}
                >
                  {copying() ? t('lightbox.copying') : t('lightbox.copyImage')}
                </button>
                <button
                  id="closeImagePreviewButton"
                  type="button"
                  class="image-lightbox-button"
                  aria-label={t('lightbox.close')}
                  ref={(el) => (closeBtnRef = el)}
                  onClick={() => actions.closeImagePreview()}
                >
                  {t('lightbox.close')}
                </button>
              </div>
            </div>
            <div class="image-lightbox-stage">
              <img
                id="imagePreviewImage"
                ref={(el) => (imgRef = el)}
                class="image-lightbox-image"
                src={preview().src}
                alt={preview().alt?.trim() || t('lightbox.defaultTitle')}
              />
            </div>
            <p id="imagePreviewStatus" class="image-lightbox-status">{feedback()}</p>
          </div>
        </div>
        );
      }}
    </Show>
  );
}
