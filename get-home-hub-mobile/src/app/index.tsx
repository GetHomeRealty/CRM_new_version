import { InvoicesSheet } from '@/components/invoices-sheet';
import { canInvoice } from '@/transactions/invoices-api';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ClientReviewsSheet } from '@/components/client-reviews-sheet';
import { InboxSheet } from '@/components/inbox-sheet';
import { AccountSettingsSheet } from '@/components/account-settings-sheet';
import { NotificationsSheet } from '@/components/notifications-sheet';
import { MetaSheet } from '@/components/meta-sheet';
import { CrmAutomationSheet } from '@/components/crm-automation-sheet';
import { FavoritesSheet, InventorySheet, MlsSheet } from '@/components/crm-resources-sheet';
import { CampaignsSheet } from '@/components/campaigns-sheet';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { MobileScreen } from '@/components/mobile-screen';
import { ModulePreview } from '@/components/module-preview';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen, hasModule } from '@/auth/access-policy';
import { fetchHubDashboard } from '@/dashboard/dashboard-api';
import { dashboardSummary } from '@/dashboard/dashboard-summary';
import { useTheme } from '@/hooks/use-theme';

export default function HomeScreen() {
  const { signOut, token, user } = useMobileAuth();
  const theme = useTheme();
  const [invoicesOpen, setInvoicesOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [reviewsOpen, setReviewsOpen] = useState(false);
  const [metaOpen, setMetaOpen] = useState(false);
  const [automation, setAutomation] = useState<'triggers' | 'communications' | null>(null);
  const [resource, setResource] = useState<'inventory' | 'mls' | 'favorites' | null>(null);
  const campaignsAllowed = canAreaScreen(user, 'crm', 'campaigns');
  const inboxArea = hasModule(user, 'crm') ? 'crm' : hasModule(user, 'desk') ? 'desk' : null;
  const dashboard = useQuery({ queryKey: ['hub-dashboard'], queryFn: ({ signal }) => fetchHubDashboard(token!, signal), enabled: Boolean(token) });
  const crm = dashboard.data?.crm;
  const desk = dashboard.data?.desk;
  const summary = dashboardSummary(dashboard.data, dashboard.isPending, dashboard.isError);
  const initials = user?.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'GH';
  return (
    <MobileScreen
      eyebrow="Get Home Realty"
      title="Good morning"
      subtitle="Your business at a glance"
      action={<Pressable accessibilityLabel="Sign out" accessibilityRole="button" onPress={signOut} style={styles.avatar}><ThemedText type="smallBold" style={styles.avatarText}>{initials}</ThemedText></Pressable>}>
      <ThemedView type="primary" style={styles.heroCard}>
        <ThemedText style={styles.heroEyebrow}>TODAY</ThemedText>
        <ThemedText style={styles.heroTitle}>{summary.title}</ThemedText>
        <ThemedText style={styles.heroCopy}>{summary.detail}</ThemedText>
        <Pressable accessibilityRole="button" onPress={() => dashboard.refetch()} style={styles.heroButton}><ThemedText type="smallBold" style={styles.heroButtonText}>Refresh dashboard</ThemedText></Pressable>
      </ThemedView>

      {canInvoice(user) ? <Pressable accessibilityRole="button" accessibilityLabel="Open invoices" onPress={() => setInvoicesOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Invoices</ThemedText></Pressable> : null}
      {invoicesOpen && token && canInvoice(user) ? <InvoicesSheet key={token} onClose={() => setInvoicesOpen(false)} /> : null}
      {dashboard.isPending ? <ActivityIndicator color={theme.primary} /> : null}
      <Pressable accessibilityRole="button" onPress={() => setAccountOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Account settings</ThemedText></Pressable>
      {accountOpen && token ? <AccountSettingsSheet key={token} onClose={() => setAccountOpen(false)} /> : null}
      <Pressable accessibilityRole="button" onPress={() => setNotificationsOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Notifications</ThemedText></Pressable>
      {notificationsOpen ? <NotificationsSheet onClose={() => setNotificationsOpen(false)} /> : null}
      {inboxArea ? <Pressable accessibilityRole="button" onPress={() => setInboxOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Open inbox</ThemedText></Pressable> : null}
      {inboxOpen && inboxArea ? <InboxSheet area={inboxArea} onClose={() => setInboxOpen(false)} /> : null}
      {campaignsAllowed ? <Pressable accessibilityRole="button" onPress={() => setCampaignsOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">View campaigns</ThemedText></Pressable> : null}
      {campaignsOpen && campaignsAllowed ? <CampaignsSheet onClose={() => setCampaignsOpen(false)} /> : null}
      {canAreaScreen(user, 'crm', 'reviews') ? <Pressable accessibilityRole="button" onPress={() => setReviewsOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Client Reviews</ThemedText></Pressable> : null}
      {reviewsOpen && token && canAreaScreen(user, 'crm', 'reviews') ? <ClientReviewsSheet key={token} onClose={() => setReviewsOpen(false)} /> : null}
      {canAreaScreen(user, 'crm', 'meta') ? <Pressable accessibilityRole="button" onPress={() => setMetaOpen(true)} style={styles.heroButton}><ThemedText type="smallBold">Meta lead ads</ThemedText></Pressable> : null}
      {metaOpen && token && canAreaScreen(user, 'crm', 'meta') ? <MetaSheet key={token} onClose={() => setMetaOpen(false)} /> : null}
      {canAreaScreen(user, 'crm', 'triggers') ? <Pressable accessibilityRole="button" onPress={() => setAutomation('triggers')} style={styles.heroButton}><ThemedText type="smallBold">CRM email choices</ThemedText></Pressable> : null}
      {hasModule(user, 'crm') ? <Pressable accessibilityRole="button" onPress={() => setAutomation('communications')} style={styles.heroButton}><ThemedText type="smallBold">CRM communications</ThemedText></Pressable> : null}
      {automation && token && hasModule(user, 'crm') ? <CrmAutomationSheet key={token} mode={automation} onClose={() => setAutomation(null)} /> : null}
      {(['inventory', 'mls', 'favorites'] as const).filter(screen => canAreaScreen(user, 'desk', screen)).map(screen => <Pressable key={screen} accessibilityRole="button" onPress={() => setResource(screen)} style={styles.heroButton}><ThemedText type="smallBold">{screen === 'inventory' ? 'Inventory' : screen === 'mls' ? 'Browse MLS' : 'Favourites'}</ThemedText></Pressable>)}
      {resource && token && canAreaScreen(user, 'desk', resource) ? resource === 'inventory' ? <InventorySheet key={token} onClose={() => setResource(null)} /> : resource === 'mls' ? <MlsSheet key={token} onClose={() => setResource(null)} /> : <FavoritesSheet key={token} onClose={() => setResource(null)} /> : null}
      {dashboard.isError ? <ThemedView type="backgroundElement" style={styles.errorCard}><ThemedText type="smallBold" themeColor="danger">Dashboard unavailable</ThemedText><ThemedText type="small" themeColor="textSecondary">{dashboard.error.message}</ThemedText></ThemedView> : null}
      {dashboard.data ? <View style={styles.metrics}>
        {crm ? <><ModulePreview label="Leads" value={String(crm.leads.total)} detail={`${crm.leads.new_this_week} new this week`} accent="primary" /><ModulePreview label="Lead tasks" value={String(crm.tasks.pending)} detail={`${crm.tasks.overdue} overdue`} accent="warning" /><ModulePreview label="Inbox" value={String(crm.inbox.unread)} detail="unread messages" accent="primary" /><ModulePreview label="Campaigns" value={String(crm.campaigns.total)} detail={`${crm.campaigns.sent} sent`} accent="success" /></> : null}
        {desk ? <><ModulePreview label="Transactions" value={String(desk.transactions.total)} detail={`${desk.closings.next_30_days} closing soon`} accent="success" /><ModulePreview label="Documents" value={String(desk.documents.pending)} detail={`${desk.documents.invalid} invalid`} accent="warning" /></> : null}
      </View> : null}
    </MobileScreen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#E30613', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#FFFFFF' },
  heroCard: { borderRadius: 24, padding: Spacing.four, gap: Spacing.two, borderCurve: 'continuous' },
  heroEyebrow: { color: '#DCD9FF', fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  heroTitle: { color: '#FFFFFF', fontSize: 24, lineHeight: 30, fontWeight: '800', maxWidth: 320 },
  heroCopy: { color: '#E8E6FF', fontSize: 14, lineHeight: 20 },
  heroButton: { alignSelf: 'flex-start', marginTop: Spacing.two, backgroundColor: '#FFFFFF', paddingHorizontal: Spacing.three, paddingVertical: 12, borderRadius: 14 },
  heroButtonText: { color: '#4036C9' },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.three },
  errorCard: { borderRadius: 18, padding: Spacing.three, gap: Spacing.two },
});
