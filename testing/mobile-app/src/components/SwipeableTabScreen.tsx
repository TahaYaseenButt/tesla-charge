import React, { useMemo, useRef } from 'react';
import { View, PanResponder, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '@/config/auth';
import { useChargerLive } from '@/hooks/useChargerLive';

export type TabName = 'index' | 'control' | 'history' | 'revenue' | 'settings';

interface SwipeableTabScreenProps {
  currentTab: TabName;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function SwipeableTabScreen({ currentTab, children, style }: SwipeableTabScreenProps) {
  const { chargerId: configuredId, user } = useAuth();
  const CHARGER_ID = (configuredId || user?.stationId || user?.defaultChargerId || 'charger1').trim().toLowerCase();
  const { hasAnyGunConnected } = useChargerLive(CHARGER_ID);

  const lastSwipeTimeRef = useRef(0);

  const tabs: TabName[] = useMemo(() => {
    if (hasAnyGunConnected) {
      return ['index', 'control', 'history', 'revenue', 'settings'];
    }
    return ['index', 'history', 'revenue', 'settings'];
  }, [hasAnyGunConnected]);

  const currentIndex = tabs.indexOf(currentTab);

  const navigateToTab = (targetTab: TabName) => {
    const route = targetTab === 'index' ? '/(tabs)' : `/(tabs)/${targetTab}`;
    router.navigate(route as any);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,

        // Only capture horizontal movements that are significantly larger than vertical movements
        onMoveShouldSetPanResponder: (_, gestureState) => {
          const dx = Math.abs(gestureState.dx);
          const dy = Math.abs(gestureState.dy);
          return dx > 25 && dx > dy * 1.8;
        },
        onMoveShouldSetPanResponderCapture: (_, gestureState) => {
          const dx = Math.abs(gestureState.dx);
          const dy = Math.abs(gestureState.dy);
          return dx > 25 && dx > dy * 1.8;
        },

        onPanResponderTerminationRequest: () => false,

        onPanResponderRelease: (_, gestureState) => {
          const now = Date.now();
          if (now - lastSwipeTimeRef.current < 400) return;

          const dx = gestureState.dx;
          const vx = gestureState.vx;
          const SWIPE_THRESHOLD = 45;
          const VELOCITY_THRESHOLD = 0.25;

          // Slide Left (finger drag towards left) -> Move to Next Tab
          if (dx < -SWIPE_THRESHOLD || (dx < -20 && vx < -VELOCITY_THRESHOLD)) {
            if (currentIndex >= 0 && currentIndex < tabs.length - 1) {
              lastSwipeTimeRef.current = now;
              navigateToTab(tabs[currentIndex + 1]);
            }
          }
          // Slide Right (finger drag towards right) -> Move to Previous Tab
          else if (dx > SWIPE_THRESHOLD || (dx > 20 && vx > VELOCITY_THRESHOLD)) {
            if (currentIndex > 0) {
              lastSwipeTimeRef.current = now;
              navigateToTab(tabs[currentIndex - 1]);
            }
          }
        },
      }),
    [currentIndex, tabs]
  );

  return (
    <View style={[styles.container, style]} {...panResponder.panHandlers}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});
