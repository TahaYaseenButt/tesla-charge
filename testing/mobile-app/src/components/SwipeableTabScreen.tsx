import React, { useMemo, useRef, useEffect } from 'react';
import { View, PanResponder, StyleSheet, StyleProp, ViewStyle, Animated, Easing } from 'react-native';
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
  const slideAnim = useRef(new Animated.Value(0)).current;
  const fadeAnim = useRef(new Animated.Value(0.92)).current;

  // Mount animation for screen entry
  useEffect(() => {
    fadeAnim.setValue(0.92);
    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 180,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [currentTab, fadeAnim]);

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

        // Intercept horizontal movements that are significantly larger than vertical movements
        onMoveShouldSetPanResponder: (_, gestureState) => {
          const dx = Math.abs(gestureState.dx);
          const dy = Math.abs(gestureState.dy);
          return dx > 20 && dx > dy * 1.4;
        },
        onMoveShouldSetPanResponderCapture: (_, gestureState) => {
          const dx = Math.abs(gestureState.dx);
          const dy = Math.abs(gestureState.dy);
          return dx > 25 && dx > dy * 1.5;
        },

        onPanResponderGrant: () => {
          slideAnim.setValue(0);
        },

        onPanResponderMove: (_, gestureState) => {
          // Dampen drag translation
          slideAnim.setValue(gestureState.dx * 0.25);
        },

        onPanResponderTerminationRequest: () => false,

        onPanResponderRelease: (_, gestureState) => {
          const dx = gestureState.dx;
          const vx = gestureState.vx;
          const SWIPE_THRESHOLD = 40;
          const VELOCITY_THRESHOLD = 0.2;

          Animated.spring(slideAnim, {
            toValue: 0,
            friction: 7,
            tension: 80,
            useNativeDriver: true,
          }).start();

          if (dx < -SWIPE_THRESHOLD || (dx < -15 && vx < -VELOCITY_THRESHOLD)) {
            triggerSwipe('next');
          } else if (dx > SWIPE_THRESHOLD || (dx > 15 && vx > VELOCITY_THRESHOLD)) {
            triggerSwipe('prev');
          }
        },
        onPanResponderTerminate: () => {
          Animated.spring(slideAnim, {
            toValue: 0,
            friction: 7,
            tension: 80,
            useNativeDriver: true,
          }).start();
        },
      }),
    [currentIndex, tabs, slideAnim]
  );

  const touchStartRef = useRef({ x: 0, y: 0, time: 0 });

  const handleTouchStart = (e: any) => {
    touchStartRef.current = {
      x: e.nativeEvent.pageX,
      y: e.nativeEvent.pageY,
      time: Date.now(),
    };
  };

  const handleTouchEnd = (e: any) => {
    const dx = e.nativeEvent.pageX - touchStartRef.current.x;
    const dy = e.nativeEvent.pageY - touchStartRef.current.y;
    const dt = Date.now() - touchStartRef.current.time;

    // Detect fast horizontal swipes that might bypass PanResponder inside ScrollViews
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.3 && dt < 700) {
      if (dx < 0) {
        triggerSwipe('next');
      } else {
        triggerSwipe('prev');
      }
    }
  };

  const triggerSwipe = (direction: 'next' | 'prev') => {
    const now = Date.now();
    if (now - lastSwipeTimeRef.current < 400) return;
    lastSwipeTimeRef.current = now;

    if (direction === 'next' && currentIndex >= 0 && currentIndex < tabs.length - 1) {
      navigateToTab(tabs[currentIndex + 1]);
    } else if (direction === 'prev' && currentIndex > 0) {
      navigateToTab(tabs[currentIndex - 1]);
    }
  };

  return (
    <Animated.View
      style={[
        styles.container,
        style,
        {
          opacity: fadeAnim,
          transform: [{ translateX: slideAnim }],
        },
      ]}
      {...panResponder.panHandlers}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});
