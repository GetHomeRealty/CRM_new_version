import { templateText } from '@/campaigns/template-text';

/** Text nodes only: never render untrusted HTML, embedded images, links or scripts. */
export function inboxBodyText(message: { body_text: string | null; body_html: string | null }): { text: string; converted: boolean; truncated: boolean } {
  const plain = message.body_text?.trim();
  if (plain) return { text: plain.slice(0, 200000), converted: false, truncated: plain.length > 200000 };
  const html = message.body_html ?? '';
  const text = templateText(html);
  return { text: text || 'This message has no readable text body.', converted: Boolean(html), truncated: html.length > 200000 };
}
