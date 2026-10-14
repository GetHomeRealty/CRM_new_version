import type { PropsWithChildren, ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';

type MobileScreenProps = PropsWithChildren<{
  eyebrow?: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}>;

export function MobileScreen({ eyebrow, title, subtitle, action, children }: MobileScreenProps) {
  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={styles.scrollContent}
          style={styles.scroll}
          showsVerticalScrollIndicator={false}>
          <View style={styles.headerRow}>
            <View style={styles.headerCopy}>
              {eyebrow ? <ThemedText style={styles.eyebrow} themeColor="primary">{eyebrow}</ThemedText> : null}
              <ThemedText type="title">{title}</ThemedText>
              {subtitle ? <ThemedText themeColor="textSecondary">{subtitle}</ThemedText> : null}
            </View>
            {action}
          </View>
          {children}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1, width: '100%' },
  scroll: { width: '100%' },
  scrollContent: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.three,
    paddingTop: Platform.OS === 'web' ? 88 : Spacing.three,
    paddingBottom: BottomTabInset + Spacing.six,
    gap: Spacing.four,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  headerCopy: { flex: 1, gap: Spacing.one },
  eyebrow: { fontSize: 12, lineHeight: 16, fontWeight: '800', letterSpacing: 1.4, textTransform: 'uppercase' },
});
