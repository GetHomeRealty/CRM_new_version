import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

type ModulePreviewProps = {
  label: string;
  value: string;
  detail: string;
  accent: 'primary' | 'success' | 'warning';
};

export function ModulePreview({ label, value, detail, accent }: ModulePreviewProps) {
  return (
    <ThemedView type="backgroundElement" style={styles.card} accessibilityLabel={`${label}: ${value}. ${detail}`}>
      <View style={styles.cardTop}>
        <ThemedView type={accent} style={styles.dot} />
        <ThemedText type="smallBold" themeColor="textSecondary">{label}</ThemedText>
      </View>
      <ThemedText style={styles.value}>{value}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">{detail}</ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, minWidth: 145, padding: Spacing.three, borderRadius: 20, gap: Spacing.one, borderCurve: 'continuous' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  dot: { width: 10, height: 10, borderRadius: 5 },
  value: { fontSize: 28, lineHeight: 34, fontWeight: '800' },
});
