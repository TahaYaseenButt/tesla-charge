import React from 'react';
import { LogBox } from 'react-native';
import { Stack, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { StatusBar } from 'expo-status-bar';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthProvider, useAuth } from '@/config/auth';
import { SimulatorProvider } from '@/config/simulator';
import {
  registerForPushNotificationsAsync,
  startBackgroundNotificationMonitor,
} from '@/services/notifications';

import { GestureHandlerRootView } from 'react-native-gesture-handler';

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
    const targetCharger = chargerId || 'charger1';
    registerForPushNotificationsAsync(user?.uid, targetCharger);
    const stopMonitor = startBackgroundNotificationMonitor(targetCharger);
    return () => {
      stopMonitor();
    };
  }, [user?.uid, chargerId]);

  React.useEffect(() => {
    async function checkForUpdates() {
      if (__DEV__) return;
      try {
        const update = await Updates.checkForUpdateAsync();
        if (update.isAvailable) {
          await Updates.fetchUpdateAsync();
          await Updates.reloadAsync();
        }
      } catch (_e) {}
    }
    checkForUpdates();
  }, []);

  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <SimulatorProvider>
          <NotificationRegistration />
          <ThemeProvider value={DefaultTheme}>
            <StatusBar style="dark" />
            <AnimatedSplashOverlay />
            <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="login" options={{ headerShown: false }} />
              <Stack.Screen name="setup" options={{ headerShown: false }} />
            </Stack>
          </ThemeProvider>
        </SimulatorProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
