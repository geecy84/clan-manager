import { getSettings } from './grading.js';

export async function discord(text) {
  const url = getSettings().notifications.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return false;
  const chunks = [];
  let rest = text;
  while (rest.length > 1900) {
    let cut = rest.lastIndexOf('\n', 1900);
    if (cut < 500) cut = 1900;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  for (const content of chunks) {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.error('Discord notify failed:', e.message);
      return false;
    }
  }
  return true;
}
