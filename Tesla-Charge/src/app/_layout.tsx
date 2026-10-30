import React from 'react';
import { LogBox } from 'react-native';
import { Stack, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/config/auth';
import { SimulatorProvider } from '@/config/simulator';
import { registerForPushNotificationsAsync } from '@/services/notifications';

export const unstable_settings = {
  anchor: '(tabs)',
};

LogBox.ignoreLogs([
  '@firebase/firestore',
  'Could not reach Cloud Firestore backend',
  'Failed to get document because the client is offline',
  'WebChannelConnection RPC',
  'transport errored',
  'Initial getDoc',
  'uses presentation "fullScreenModal"',
  'permission_denied at /live',
  'FIREBASE WARNING: update at /live',
  /@firebase\/firestore/,
  /@firebase\/database/,
  /Could not reach Cloud Firestore backend/,
  /Failed to get document because the client is offline/,
  /WebChannelConnection RPC/,
  /transport errored/,
  /permission_denied/,
  /uses presentation "fullScreenModal"/,
]);

SplashScreen.preventAutoHideAsync();

function NotificationRegistration() {
  const { user, chargerId } = useAuth();

  React.useEffect(() => {
    registerForPushNotificationsAsync(user?.uid, chargerId || 'charger1');
  }, [user?.uid, chargerId]);

  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <SimulatorProvider>
        <NotificationRegistration />
        <ThemeProvider value={DefaultTheme}>
          <AnimatedSplashOverlay />
          <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="setup" options={{ headerShown: false }} />
          </Stack>
        </ThemeProvider>
      </SimulatorProvider>
    </AuthProvider>
  );
}
