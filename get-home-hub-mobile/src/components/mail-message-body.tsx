import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formattedMail } from '@/inbox/formatted-body';
import { inboxBodyText } from '@/inbox/message-body';
import { useTheme } from '@/hooks/use-theme';
import { ThemedText } from './themed-text';
export function MailMessageBody({ body_text, body_html }: { body_text: string | null; body_html: string | null }) {
  const theme = useTheme();
  const [formatted, setFormatted] = useState(Boolean(body_html && !body_text?.trim()));
  const rich = useMemo(() => formatted && body_html ? formattedMail(body_html) : null, [body_html, formatted]);
  const plain = useMemo(() => inboxBodyText({ body_text, body_html }), [body_text, body_html]);
  return <View style={{ gap: 12 }}>
    {body_html ? <Pressable accessibilityRole="button" onPress={() => setFormatted(v => !v)} style={{ minHeight: 44, padding: 12 }}><ThemedText>{formatted ? 'Show plain text' : 'Show formatted email'}</ThemedText></Pressable> : null}
    {rich ? <><ThemedText type="small">Formatted text only. Links are inactive; remote images and interactive content are not loaded.</ThemedText>
      {rich.blocks.length ? rich.blocks.map((block, index) => <Text key={index} selectable style={{ color: theme.text, fontSize: block.heading ? Math.max(16, 28 - block.heading * 2) : 16, fontWeight: block.heading ? '700' : '400', lineHeight: block.heading ? 32 : 24 }}>{block.prefix}{block.spans.map((span, part) => <Text key={part} style={{ fontWeight: span.bold ? '700' : undefined, fontStyle: span.italic ? 'italic' : undefined, textDecorationLine: span.underline ? 'underline' : undefined, fontFamily: span.code ? 'monospace' : undefined }}>{span.text}</Text>)}</Text>) : <ThemedText>No readable formatted content. Choose plain text or open your mail provider.</ThemedText>}
      {rich.mediaOmitted ? <ThemedText type="small">Embedded media was omitted.</ThemedText> : null}</> : <ThemedText selectable>{plain.text}</ThemedText>}
    {(rich?.truncated || (!rich && plain.truncated)) ? <ThemedText accessibilityRole="alert">This long message is shortened. Open your mail provider to read the full message.</ThemedText> : null}
  </View>;
}
