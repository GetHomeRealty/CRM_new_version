import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export type RecordItem = {
  id?: number | string;
  title: string;
  detail: string;
  meta: string;
  tone?: 'primary' | 'success' | 'warning';
};

export function RecordList({ items, onPress }: { items: RecordItem[]; onPress?: (item: RecordItem) => void }) {
  return (
    <ThemedView type="backgroundElement" style={styles.list}>
      {items.map((item, index) => (
        <Pressable
          key={item.id ?? `${item.title}-${item.meta}`}
          accessibilityRole="button"
          onPress={onPress ? () => onPress(item) : undefined}
          style={({ pressed }) => [styles.row, index > 0 && styles.border, pressed && styles.pressed]}>
          <ThemedView type={item.tone ?? 'primarySoft'} style={styles.marker} />
          <View style={styles.copy}>
            <ThemedText type="smallBold" numberOfLines={1}>{item.title}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>{item.detail}</ThemedText>
          </View>
          <ThemedText type="smallBold" themeColor={item.tone ?? 'primary'}>{item.meta}</ThemedText>
        </Pressable>
      ))}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  list: { borderRadius: 20, paddingHorizontal: Spacing.three, borderCurve: 'continuous' },
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: 12 },
  border: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#D6DAE4' },
  pressed: { opacity: 0.65 },
  marker: { width: 4, height: 36, borderRadius: 2 },
  copy: { flex: 1, gap: 3 },
});
