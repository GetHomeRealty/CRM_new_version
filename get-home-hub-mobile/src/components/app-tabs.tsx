import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useColorScheme } from 'react-native';

import { Colors } from '@/constants/theme';
import { useMobileAuth } from '@/auth/auth-context';
import { canAreaScreen } from '@/auth/access-policy';

export default function AppTabs() {
  const { user } = useMobileAuth();
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'unspecified' ? 'light' : scheme];

  return (
    <NativeTabs
      backgroundColor={colors.background}
      iconColor={{ default: colors.textSecondary, selected: colors.primary }}
      indicatorColor={colors.primarySoft}
      labelVisibilityMode="labeled"
      labelStyle={{
        default: { color: colors.textSecondary, fontSize: 11, fontWeight: '600' },
        selected: { color: colors.primary, fontSize: 11, fontWeight: '700' },
      }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="leads" hidden={!canAreaScreen(user, 'crm', 'lead')}>
        <NativeTabs.Trigger.Label>Leads</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'person.2', selected: 'person.2.fill' }}
          md={{ default: 'group', selected: 'group' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="transactions" hidden={!canAreaScreen(user, 'desk', 'transactions')}>
        <NativeTabs.Trigger.Label>Transactions</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'doc.text', selected: 'doc.text.fill' }}
          md={{ default: 'description', selected: 'description' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="calendar" hidden={!canAreaScreen(user, 'crm', 'calendar') && !canAreaScreen(user, 'desk', 'calendar')}>
        <NativeTabs.Trigger.Label>Calendar</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'calendar', selected: 'calendar.circle.fill' }} md={{ default: 'calendar_month', selected: 'calendar_month' }} />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="precon">
        <NativeTabs.Trigger.Label>Precon</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'building.2', selected: 'building.2.fill' }}
          md={{ default: 'apartment', selected: 'apartment' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
