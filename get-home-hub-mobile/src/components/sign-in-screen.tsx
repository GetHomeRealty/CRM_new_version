import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMobileAuth } from '@/auth/auth-context';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

export function SignInScreen() {
  const { error, signIn, signingIn, canRetrySession, retrySession } = useMobileAuth();
  return (
    <ThemedView style={styles.screen}>
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.brand}>
          <View style={styles.mark}><ThemedText style={styles.markText}>GH</ThemedText></View>
          <View>
            <ThemedText style={styles.brandName}>GET HOME REALTY</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">Get Home Hub</ThemedText>
          </View>
        </View>
        <View style={styles.copy}>
          <ThemedText style={styles.eyebrow} themeColor="primary">ONE SECURE ACCOUNT</ThemedText>
          <ThemedText style={styles.title}>Your entire business, in one place.</ThemedText>
          <ThemedText style={styles.subtitle} themeColor="textSecondary">
            Use the same CRM account for Leads, Transactions, and Precon/Canada.
          </ThemedText>
        </View>
        <ThemedView type="backgroundElement" style={styles.card}>
          <View style={styles.shield}><ThemedText style={styles.shieldText}>✓</ThemedText></View>
          <View style={styles.cardCopy}>
            <ThemedText type="smallBold">Protected by CRM sign-in</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">Passwords and MFA stay on the trusted CRM sign-in page.</ThemedText>
          </View>
        </ThemedView>
        {error ? <ThemedText style={styles.error} accessibilityLiveRegion="polite">{error}</ThemedText> : null}
        {canRetrySession ? <Pressable accessibilityRole="button" accessibilityLabel="Retry saved session connection" accessibilityState={{ disabled: signingIn, busy: signingIn }} disabled={signingIn} onPress={retrySession} style={[styles.button, signingIn && styles.buttonDisabled]}><ThemedText style={styles.buttonText}>{signingIn ? 'Reconnecting…' : 'Retry saved session'}</ThemedText></Pressable> : null}
        <Pressable
          accessibilityRole="button"
          disabled={signingIn || Platform.OS === 'web'}
          onPress={signIn}
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, (signingIn || Platform.OS === 'web') && styles.buttonDisabled]}>
          {signingIn ? <ActivityIndicator color="#FFFFFF" /> : <ThemedText type="smallBold" style={styles.buttonText}>Continue with CRM account</ThemedText>}
        </Pressable>
        {Platform.OS === 'web' ? <ThemedText type="small" themeColor="textSecondary" style={styles.webNote}>This browser is a design preview. Secure CRM sign-in runs in the iOS or Android app.</ThemedText> : null}
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  safeArea: { flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center', padding: Spacing.four, justifyContent: 'center', gap: Spacing.four },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12, position: 'absolute', top: 72, left: Spacing.four },
  mark: { width: 46, height: 46, borderRadius: 15, backgroundColor: '#E30613', alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#FFFFFF', fontWeight: '900', fontSize: 15, letterSpacing: -0.4 },
  brandName: { fontSize: 13, lineHeight: 17, fontWeight: '900', letterSpacing: 1.1 },
  copy: { gap: 12 },
  eyebrow: { fontSize: 12, fontWeight: '900', letterSpacing: 1.4 },
  title: { fontSize: 38, lineHeight: 44, fontWeight: '900', letterSpacing: -1.2 },
  subtitle: { fontSize: 17, lineHeight: 25 },
  card: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, borderRadius: 18, padding: Spacing.three, borderWidth: StyleSheet.hairlineWidth, borderColor: '#DDE1EA' },
  shield: { width: 40, height: 40, borderRadius: 13, backgroundColor: '#E8F7F1', alignItems: 'center', justifyContent: 'center' },
  shieldText: { color: '#188764', fontWeight: '900', fontSize: 20 },
  cardCopy: { flex: 1, gap: 3 },
  error: { color: '#D14343', fontSize: 14, lineHeight: 20 },
  button: { height: 56, borderRadius: 17, backgroundColor: '#5146E5', alignItems: 'center', justifyContent: 'center' },
  buttonPressed: { transform: [{ scale: 0.99 }], opacity: 0.92 },
  buttonDisabled: { opacity: 0.55 },
  buttonText: { color: '#FFFFFF', fontSize: 16 },
  webNote: { textAlign: 'center', lineHeight: 19 },
});
