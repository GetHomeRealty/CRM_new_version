import { createContext, useContext } from 'react';
import type { PushState } from './native-push-session';
export interface NativePushControls { state: PushState; busy: boolean; enable: () => Promise<void>; disable: () => Promise<void>; refresh: () => Promise<void> }
export const NativePushContext = createContext<NativePushControls | null>(null);
export const useNativePush = () => useContext(NativePushContext);
