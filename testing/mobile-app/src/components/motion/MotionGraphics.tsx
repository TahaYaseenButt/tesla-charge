import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  Animated,
  StyleSheet,
  StyleProp,
  ViewStyle,
  TextStyle,
  Easing,
} from 'react-native';

/**
 * Case 1: Electric Flow Pulse
 * Shimmers and pulses an active energy glow around charging battery and active gun card
 */
export function ElectricFlowPulse({
  active = true,
  color = '#10B981',
  children,
  style,
}: {
  active?: boolean;
  color?: string;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const pulseAnim = useRef(new Animated.Value(0.35)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) {
      pulseAnim.setValue(0);
      scaleAnim.setValue(1);
      return;
    }

    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.95,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 0.35,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.015,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 1000,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [active, pulseAnim, scaleAnim]);

  if (!active) {
    return <View style={style}>{children}</View>;
  }

  return (
    <View style={[styles.pulseContainer, style]}>
      {/* Outer ambient energy halo */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          styles.glowHalo,
          {
            borderColor: color,
            opacity: pulseAnim,
            transform: [{ scale: scaleAnim }],
          },
        ]}
      />
      {children}
    </View>
  );
}

/**
 * Electric Wave Shimmer for Battery Fill Bar
 * Runs a continuous light beam across the active green charging bar
 */
export function ElectricWaveShimmer({ active = true }: { active?: boolean }) {
  const shimmerAnim = useRef(new Animated.Value(-100)).current;

  useEffect(() => {
    if (!active) return;

    const shimmerLoop = Animated.loop(
      Animated.timing(shimmerAnim, {
        toValue: 300,
        duration: 1600,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );

    shimmerLoop.start();
    return () => shimmerLoop.stop();
  }, [active, shimmerAnim]);

  if (!active) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.shimmerBeam,
        {
          transform: [{ translateX: shimmerAnim }],
        },
      ]}
    />
  );
}

/**
 * Case 2: Live Number Transitions (Ticker Spring)
 * Micro-spring animation whenever metric values (kW, SoC, Cost) tick
 */
export function AnimatedMetricValue({
  value,
  style,
}: {
  value: string | number;
  style?: StyleProp<TextStyle>;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const prevVal = useRef(value);

  useEffect(() => {
    if (prevVal.current !== value) {
      prevVal.current = value;
      scale.setValue(1.06);
      opacity.setValue(0.75);

      Animated.parallel([
        Animated.spring(scale, {
          toValue: 1,
          friction: 6,
          tension: 140,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [value, scale, opacity]);

  return (
    <Animated.Text
      style={[
        style,
        {
          transform: [{ scale }],
          opacity,
        },
      ]}
    >
      {value}
    </Animated.Text>
  );
}

/**
 * Case 3: Reconnection Heartbeat Pulse
 * Gentle breathing radar pulse next to the OFFLINE hero card
 */
export function ReconnectionHeartbeat({
  color = '#94A3B8',
}: {
  color?: string;
}) {
  const pulseScale = useRef(new Animated.Value(1)).current;
  const pulseOpacity = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.timing(pulseScale, {
          toValue: 2.2,
          duration: 1800,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseOpacity, {
          toValue: 0,
          duration: 1800,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    loop.start();
    return () => loop.stop();
  }, [pulseScale, pulseOpacity]);

  return (
    <View style={styles.heartbeatContainer}>
      {/* Expanding Radar Ring */}
      <Animated.View
        style={[
          styles.heartbeatRing,
          {
            borderColor: color,
            opacity: pulseOpacity,
            transform: [{ scale: pulseScale }],
          },
        ]}
      />
      {/* Solid Core Dot */}
      <View style={[styles.heartbeatCore, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  pulseContainer: {
    position: 'relative',
  },
  glowHalo: {
    borderRadius: 16,
    borderWidth: 1.5,
    backgroundColor: 'rgba(16, 185, 129, 0.04)',
    margin: -2,
  },
  shimmerBeam: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.45)',
    borderRadius: 4,
  },
  heartbeatContainer: {
    width: 14,
    height: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  heartbeatRing: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1.5,
  },
  heartbeatCore: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
