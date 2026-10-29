import React, { useEffect, useRef } from 'react';
import {
  View,
  StyleSheet,
  Animated,
  Platform,
  ViewStyle,
  StyleProp,
  DimensionValue,
} from 'react-native';

interface SkeletonBlockProps {
  width?: DimensionValue;
  height?: DimensionValue;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Reusable animated pulsating skeleton block with native 60fps driver
 */
export function SkeletonBlock({
  width = '100%',
  height = 20,
  borderRadius = 8,
  style,
}: SkeletonBlockProps) {
  const opacity = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.85,
          duration: 750,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.35,
          duration: 750,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();

    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.skeletonBase,
        {
          width,
          height,
          borderRadius,
          opacity,
        },
        style,
      ]}
    />
  );
}

/**
 * Full-screen skeleton layout matching the Tesla Charge home dashboard
 */
export function DashboardSkeleton({ isSingleGun = false }: { isSingleGun?: boolean } = {}) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Header Skeleton */}
        <View style={styles.headerRow}>
          <SkeletonBlock width={140} height={26} borderRadius={8} />
          <SkeletonBlock width={92} height={26} borderRadius={999} />
        </View>

        {/* Hero Vehicle / Charger Stage Skeleton */}
        <View style={styles.heroStage}>
          <SkeletonBlock width={130} height={150} borderRadius={18} />
        </View>

        {/* Central Power & Tariff Skeleton */}
        <View style={styles.powerSection}>
          <SkeletonBlock width={130} height={42} borderRadius={10} style={styles.centerSelf} />
          <SkeletonBlock width={180} height={14} borderRadius={6} style={[styles.centerSelf, { marginTop: 8 }]} />
        </View>

        {/* Telemetry Cards Skeleton */}
        <View style={styles.cardsContainer}>
          {/* Card 1 */}
          <View style={styles.cardSkeleton}>
            <View style={styles.cardHeaderRow}>
              <SkeletonBlock width={isSingleGun ? 110 : 80} height={16} borderRadius={6} />
              <SkeletonBlock width={74} height={20} borderRadius={6} />
            </View>
            <View style={styles.metricsRow}>
              <View style={styles.metricItem}>
                <SkeletonBlock width={50} height={10} borderRadius={4} />
                <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
              </View>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <SkeletonBlock width={50} height={10} borderRadius={4} />
                <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
              </View>
              <View style={styles.divider} />
              <View style={styles.metricItem}>
                <SkeletonBlock width={50} height={10} borderRadius={4} />
                <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
              </View>
            </View>
          </View>

          {/* Card 2 (Only if not single gun) */}
          {!isSingleGun && (
            <View style={styles.cardSkeleton}>
              <View style={styles.cardHeaderRow}>
                <SkeletonBlock width={80} height={16} borderRadius={6} />
                <SkeletonBlock width={74} height={20} borderRadius={6} />
              </View>
              <View style={styles.metricsRow}>
                <View style={styles.metricItem}>
                  <SkeletonBlock width={50} height={10} borderRadius={4} />
                  <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
                </View>
                <View style={styles.divider} />
                <View style={styles.metricItem}>
                  <SkeletonBlock width={50} height={10} borderRadius={4} />
                  <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
                </View>
                <View style={styles.divider} />
                <View style={styles.metricItem}>
                  <SkeletonBlock width={50} height={10} borderRadius={4} />
                  <SkeletonBlock width={64} height={18} borderRadius={6} style={{ marginTop: 6 }} />
                </View>
              </View>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

/**
 * Skeleton layout for the History tab
 */
export function HistorySkeleton() {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {/* Title row */}
        <View style={styles.headerRow}>
          <SkeletonBlock width={180} height={26} borderRadius={8} />
          <SkeletonBlock width={120} height={32} borderRadius={8} />
        </View>

        {/* Sync row */}
        <View style={styles.headerRow}>
          <SkeletonBlock width={190} height={28} borderRadius={8} />
          <SkeletonBlock width={100} height={28} borderRadius={8} />
        </View>

        {/* Scope selector */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <SkeletonBlock width="48%" height={40} borderRadius={10} />
          <SkeletonBlock width="48%" height={40} borderRadius={10} />
        </View>

        {/* Summary Card */}
        <View style={[styles.cardSkeleton, { padding: 18, gap: 16 }]}>
          <SkeletonBlock width={120} height={16} borderRadius={6} />
          <View style={styles.metricsRow}>
            <View style={styles.metricItem}>
              <SkeletonBlock width={50} height={10} borderRadius={4} />
              <SkeletonBlock width={70} height={22} borderRadius={6} style={{ marginTop: 6 }} />
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <SkeletonBlock width={50} height={10} borderRadius={4} />
              <SkeletonBlock width={70} height={22} borderRadius={6} style={{ marginTop: 6 }} />
            </View>
            <View style={styles.divider} />
            <View style={styles.metricItem}>
              <SkeletonBlock width={50} height={10} borderRadius={4} />
              <SkeletonBlock width={70} height={22} borderRadius={6} style={{ marginTop: 6 }} />
            </View>
          </View>
        </View>

        {/* List items */}
        <View style={{ gap: 12 }}>
          {[1, 2, 3].map((key) => (
            <View key={key} style={[styles.cardSkeleton, { padding: 14, gap: 10 }]}>
              <View style={styles.cardHeaderRow}>
                <SkeletonBlock width={110} height={16} borderRadius={6} />
                <SkeletonBlock width={64} height={18} borderRadius={6} />
              </View>
              <View style={styles.headerRow}>
                <SkeletonBlock width={140} height={12} borderRadius={4} />
                <SkeletonBlock width={80} height={16} borderRadius={6} />
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: Platform.OS === 'ios' ? 56 : 36,
    paddingBottom: 40,
    gap: 16,
  },
  skeletonBase: {
    backgroundColor: '#CBD5E1',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  heroStage: {
    height: 210,
    backgroundColor: '#F8FAFC',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerSection: {
    alignItems: 'center',
    marginVertical: 4,
  },
  centerSelf: {
    alignSelf: 'center',
  },
  cardsContainer: {
    gap: 14,
  },
  cardSkeleton: {
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    borderRadius: 16,
    padding: 16,
    gap: 14,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metricItem: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: 1,
    height: 28,
    backgroundColor: '#E2E8F0',
  },
});
