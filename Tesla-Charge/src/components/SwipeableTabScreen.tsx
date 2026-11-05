import React from 'react';
import { View, StyleSheet, StyleProp, ViewStyle } from 'react-native';

export type TabName = 'index' | 'control' | 'history' | 'revenue' | 'settings';

interface SwipeableTabScreenProps {
  currentTab?: TabName;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function SwipeableTabScreen({ children, style }: SwipeableTabScreenProps) {
  return <View style={[styles.container, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFFFFF',
  },
});

