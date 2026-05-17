import { onMount } from 'solid-js';
import { actions, state } from './store';
import { Header, ErrorBanner } from './components/Header';
import { ConfigPanel } from './components/ConfigPanel';
import { MessageList } from './components/MessageList';
import { Composer } from './components/Composer';
import { ImageLightbox } from './components/ImageLightbox';
import { LargeEditor } from './components/LargeEditor';
import { attachCodeBlockDelegation, syncLayoutMetrics } from './dom';

export function App() {
  let shellRef: HTMLDivElement | undefined;

  onMount(() => {
    if (shellRef) attachCodeBlockDelegation(shellRef);
    syncLayoutMetrics();
    // Notify host that webview is ready to receive document state
    actions.ready();
    // Wheel-up disables auto-follow (mirror old behavior)
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && state.autoFollow) actions.setAutoFollow(false);
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  });

  return (
    <div class="shell" ref={(el) => (shellRef = el)}>
      <main class="page">
        <Header />
        <ErrorBanner />
        <ConfigPanel />
        <MessageList />
      </main>
      <Composer />
      <ImageLightbox />
      <LargeEditor />
    </div>
  );
}
