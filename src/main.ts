import { bootBrowser } from '@app/boot';

const canvas = document.querySelector<HTMLCanvasElement>('#stage');
if (canvas === null) throw new Error('The stage canvas is missing.');

void bootBrowser(canvas).catch(error => {
  const message = document.createElement('p');
  message.textContent = error instanceof Error ? error.message : String(error);
  message.style.color = 'white';
  document.body.append(message);
});
