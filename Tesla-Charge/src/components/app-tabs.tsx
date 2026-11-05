import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
  Platform,
  NativeSyntheticEvent,
  NativeScrollEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';
import { usePathname } from 'expo-router';
import { useAuth } from '@/config/auth';
import { useChargerLive } from '@/hooks/useChargerLive';

import HomeScreen from '@/app/(tabs)/index';
import ControlScreen from '@/app/(tabs)/control';
import HistoryScreen from '@/app/(tabs)/history';
import RevenueScreen from '@/app/(tabs)/revenue';
import SettingsScreen from '@/app/(tabs)/settings';

type TabKey = 'index' | 'control' | 'history' | 'revenue' | 'settings';

interface TabItemConfig {
  key: TabKey;
  label: string;
  sf: string;
  md: any;
  emoji: string;
}

const ALL_TABS: Record<TabKey, TabItemConfig> = {
  index: {
    key: 'index',
    label: 'Home',
    sf: 'house.fill',
    md: 'home',
    emoji: '🏠',
  },
  control: {
    key: 'control',
    label: 'Control',
    sf: 'bolt.car.fill',
    md: 'electric_bolt',
    emoji: '⚡',
  },
  history: {
    key: 'history',
    label: 'History',
    sf: 'clock.fill',
    md: 'history',
    emoji: '🕒',
  },
  revenue: {
    key: 'revenue',
    label: 'Revenue',
    sf: 'chart.bar.fill',
    md: 'bar_chart',
    emoji: '📊',
  },
  settings: {
    key: 'settings',
    label: 'Settings',
    sf: 'gearshape.fill',
    md: 'settings',
    emoji: '⚙️',
  },
};

export default function AppTabs() {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const { chargerId } = useAuth();
  const { hasAnyGunConnected } = useChargerLive(chargerId || 'charger1');
  const pathname = usePathname();

  const [activeIndex, setActiveIndex] = useState(0);
  const activeTabKeyRef = useRef<TabKey>('index');
  const pagerRef = useRef<React.ElementRef<typeof ScrollView>>(null);
  const isProgrammaticScrollRef = useRef(false);

  // Active tabs list: dynamically includes 'control' only when a gun is connected/charging
  const visibleTabs = useMemo(() => {
    const list: TabItemConfig[] = [ALL_TABS.index];
    if (hasAnyGunConnected) {
      list.push(ALL_TABS.control);
    }
    list.push(ALL_TABS.history);
    list.push(ALL_TABS.revenue);
    list.push(ALL_TABS.settings);
    return list;
  }, [hasAnyGunConnected]);

  // Handle dynamic gun connection changes without jumping away from the current screen
  useEffect(() => {
    const currentKey = activeTabKeyRef.current;
    const newIdx = visibleTabs.findIndex((t) => t.key === currentKey);
    if (newIdx >= 0 && newIdx !== activeIndex) {
      setActiveIndex(newIdx);
      pagerRef.current?.scrollTo({ x: newIdx * screenWidth, animated: false });
    } else if (newIdx === -1) {
      // If the tab was closed (e.g. control disconnected), fall back to Home
      setActiveIndex(0);
      activeTabKeyRef.current = 'index';
      pagerRef.current?.scrollTo({ x: 0, animated: false });
    }
  }, [visibleTabs, screenWidth]);

  // Handle external pathname changes (e.g. deep links or router.push('/(tabs)'))
  useEffect(() => {
    if (!pathname) return;
    const clean = pathname.replace(/^\/\(tabs\)/, '').replace(/^\//, '');
    const targetKey: TabKey = clean === '' ? 'index' : (clean as TabKey);
    const targetIdx = visibleTabs.findIndex((t) => t.key === targetKey);
    if (targetIdx >= 0 && targetIdx !== activeIndex) {
      isProgrammaticScrollRef.current = true;
      setActiveIndex(targetIdx);
      activeTabKeyRef.current = targetKey;
      pagerRef.current?.scrollTo({ x: targetIdx * screenWidth, animated: true });
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 350);
    }
  }, [pathname, visibleTabs, screenWidth]);

  // Continuous real-time scroll tracking: updates active tab smoothly during gestures
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (isProgrammaticScrollRef.current) return;
      const offsetX = e.nativeEvent.contentOffset.x;
      const index = Math.round(offsetX / screenWidth);
      if (index >= 0 && index < visibleTabs.length && index !== activeIndex) {
        setActiveIndex(index);
        activeTabKeyRef.current = visibleTabs[index].key;
      }
    },
    [screenWidth, visibleTabs, activeIndex]
  );

  const handleMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      isProgrammaticScrollRef.current = false;
      const offsetX = e.nativeEvent.contentOffset.x;
      const index = Math.round(offsetX / screenWidth);
      if (index >= 0 && index < visibleTabs.length) {
        setActiveIndex(index);
        activeTabKeyRef.current = visibleTabs[index].key;
      }
    },
    [screenWidth, visibleTabs]
  );

  const handleTabPress = useCallback(
    (index: number) => {
      if (index === activeIndex) return;
      isProgrammaticScrollRef.current = true;
      setActiveIndex(index);
      activeTabKeyRef.current = visibleTabs[index].key;
      pagerRef.current?.scrollTo({ x: index * screenWidth, animated: true });
      setTimeout(() => {
        isProgrammaticScrollRef.current = false;
      }, 350);
    },
    [activeIndex, visibleTabs, screenWidth]
  );

  return (
    <View style={styles.rootContainer}>
      {/* 1:1 Real-time Horizontal ViewPager */}
      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        directionalLockEnabled
        nestedScrollEnabled
        scrollEventThrottle={16}
        removeClippedSubviews={false}
        onScroll={handleScroll}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        style={styles.pager}
        contentContainerStyle={{ width: screenWidth * visibleTabs.length }}
      >
        {visibleTabs.map((tab) => (
          <View key={tab.key} style={[styles.pageWrapper, { width: screenWidth }]}>
            {tab.key === 'index' && <HomeScreen />}
            {tab.key === 'control' && <ControlScreen />}
            {tab.key === 'history' && <HistoryScreen />}
            {tab.key === 'revenue' && <RevenueScreen />}
            {tab.key === 'settings' && <SettingsScreen />}
          </View>
        ))}
      </ScrollView>

      {/* Modern High-End Bottom Navigation Bar */}
      <View
        style={[
          styles.bottomTabBar,
          {
            paddingBottom: Math.max(insets.bottom, 8),
            height: 56 + Math.max(insets.bottom, 8),
          },
        ]}
      >
        {visibleTabs.map((tab, idx) => {
          const isActive = idx === activeIndex;
          const tintColor = isActive ? '#0284C7' : '#64748B';

          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => handleTabPress(idx)}
              activeOpacity={0.7}
              style={styles.tabBtn}
            >
              <View style={[styles.tabIconWrapper, isActive && styles.tabIconWrapperActive]}>
                <SymbolView
                  name={{
                    ios: tab.sf as any,
                    android: tab.md as any,
                  }}
                  tintColor={tintColor}
                  size={22}
                  fallback={<Text style={{ fontSize: 18 }}>{tab.emoji}</Text>}
                />
              </View>
              <Text
                style={[
                  styles.tabLabel,
                  { color: tintColor },
                  isActive && styles.tabLabelActive,
                ]}
                numberOfLines={1}
              >
                {tab.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  pager: {
    flex: 1,
  },
  pageWrapper: {
    flex: 1,
    height: '100%',
  },
  bottomTabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: '#FFFFFF',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E2E8F0',
    paddingHorizontal: 8,
    paddingTop: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOffset: { width: 0, height: -3 },
        shadowOpacity: 0.05,
        shadowRadius: 6,
      },
      android: {
        elevation: 8,
      },
    }),
  },
  tabBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  tabIconWrapper: {
    width: 42,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  tabIconWrapperActive: {
    backgroundColor: '#F0F9FF',
  },
  tabLabel: {
    fontSize: 10.5,
    fontWeight: '500',
    marginTop: 2,
    letterSpacing: -0.2,
  },
  tabLabelActive: {
    fontWeight: '700',
  },
});
