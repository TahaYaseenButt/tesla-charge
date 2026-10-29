import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';
import { Colors } from '@/constants/theme';
import { useAuth } from '@/config/auth';
import { useChargerLive } from '@/hooks/useChargerLive';

export default function AppTabs() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];
  const { chargerId } = useAuth();
  const { hasAnyGunConnected } = useChargerLive(chargerId || 'charger1');

  return (
    <NativeTabs
      backgroundColor="#FFFFFF"
      indicatorColor="#F1F5F9"
      labelStyle={{ selected: { color: '#0284C7' }, default: { color: '#64748B' } }}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'house', selected: 'house.fill' }}
          md={{ default: 'home', selected: 'home' }}
        />
      </NativeTabs.Trigger>

      {/* Dynamic Control Tab: ONLY appears when a gun is connected/charging */}
      {hasAnyGunConnected && (
        <NativeTabs.Trigger name="control">
          <NativeTabs.Trigger.Label>Control</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon
            sf={{ default: 'bolt.car', selected: 'bolt.car.fill' }}
            md={{ default: 'electric_bolt', selected: 'electric_bolt' }}
          />
        </NativeTabs.Trigger>
      )}


      <NativeTabs.Trigger name="history">
        <NativeTabs.Trigger.Label>History</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'clock', selected: 'clock.fill' }}
          md={{ default: 'history', selected: 'history' }}
        />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon
          sf={{ default: 'gearshape', selected: 'gearshape.fill' }}
          md={{ default: 'settings', selected: 'settings' }}
        />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
