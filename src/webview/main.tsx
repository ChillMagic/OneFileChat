import { render } from 'solid-js/web';
import { setLocale, normalizeLocale } from '../shared/i18n';
import { App } from './App';

// The extension host stamps the active locale onto <html lang="…"> in
// getHtml(), so the webview just mirrors it.
setLocale(normalizeLocale(document.documentElement.lang || (navigator.language ?? '')));

const root = document.getElementById('root');
if (root) {
  render(() => <App />, root);
}
