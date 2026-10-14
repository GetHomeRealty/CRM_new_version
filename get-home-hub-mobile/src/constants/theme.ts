/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { Platform } from 'react-native';

export const Colors = {
  light: {
    text: '#172033',
    background: '#F6F7FB',
    backgroundElement: '#FFFFFF',
    backgroundSelected: '#EEF0FF',
    textSecondary: '#687386',
    primary: '#5146E5',
    primarySoft: '#E9E7FF',
    border: '#E4E7EF',
    success: '#188764',
    warning: '#C26A15',
    danger: '#D14343',
  },
  dark: {
    text: '#F6F7FB',
    background: '#111522',
    backgroundElement: '#1B2130',
    backgroundSelected: '#28294F',
    textSecondary: '#A7B0C0',
    primary: '#9B94FF',
    primarySoft: '#292750',
    border: '#2A3243',
    success: '#63D4AD',
    warning: '#F6B26E',
    danger: '#FF8B8B',
  },
} as const;

export type ThemeColor = keyof typeof Colors.light & keyof typeof Colors.dark;

export const Fonts = Platform.select({
  ios: {
    /** iOS `UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOS `UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOS `UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOS `UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
