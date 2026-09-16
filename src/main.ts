import { bootBrowser } from '@app/boot';
import { createBrowserSession, type BrowserSession } from '@app/BrowserSession';
import { mountTitleScreen } from '@app/screens/TitleScreen';
import { UnsupportedBrowserError } from '@platform';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('The stage canvas is missing.');
void bootBrowser(canvas).then(boot => {
  let session: BrowserSession | null = null;
  const title = (): void => {
    session?.dispose(); session = null;
    mountTitleScreen(boot, async (start, selected) => { session = await createBrowserSession(selected, start); });
  };
  boot.overlay.addEventListener('kt:title', title);
  title();
}).catch(error => {
  if (error instanceof UnsupportedBrowserError) return;
  const message = document.createElement('p');
  message.textContent = error instanceof Error ? error.message : String(error);
  message.style.color = 'white'; document.body.append(message);
});
