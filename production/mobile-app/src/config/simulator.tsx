import React, { createContext, useContext, useState, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SimulatorScenario =
  | 'live'
  | 'both_plugged'
  | 'both_charging'
  | 'single_charging'
  | 'single_preparing'
  | 'standby';

export interface SimulatedGunData {
  status: string;
  powerKw: number;
  voltage: number;
  current: number;
  soc: number;
  energyKwh: number;
  cost: number;
}

export interface SimulatorState {
  scenario: SimulatorScenario;
  isSimulating: boolean;
  gunA: SimulatedGunData;
  gunB: SimulatedGunData;
  setScenario: (sc: SimulatorScenario) => void;
}

const DEFAULT_SCENARIOS: Record<SimulatorScenario, { gunA: SimulatedGunData; gunB: SimulatedGunData }> = {
  live: {
    gunA: { status: 'Available', powerKw: 0, voltage: 0, current: 0, soc: 0, energyKwh: 0, cost: 0 },
    gunB: { status: 'Available', powerKw: 0, voltage: 0, current: 0, soc: 0, energyKwh: 0, cost: 0 },
  },
  both_plugged: {
    // Matches the exact scenario: Gun A charging at 36.8 kW, Gun B plugged at 86%
    gunA: { status: 'Charging', powerKw: 36.8, voltage: 353, current: 104.2, soc: 26, energyKwh: 1.24, cost: 155 },
    gunB: { status: 'Preparing', powerKw: 0.0, voltage: 4, current: 0.0, soc: 86, energyKwh: 0.00, cost: 0 },
  },
  both_charging: {
    gunA: { status: 'Charging', powerKw: 117.2, voltage: 419, current: 279.9, soc: 45, energyKwh: 5.64, cost: 705 },
    gunB: { status: 'Charging', powerKw: 85.0, voltage: 400, current: 212.5, soc: 60, energyKwh: 4.20, cost: 525 },
  },
  single_charging: {
    gunA: { status: 'Charging', powerKw: 120.0, voltage: 420, current: 285.7, soc: 52, energyKwh: 8.50, cost: 1062 },
    gunB: { status: 'Available', powerKw: 0.0, voltage: 0, current: 0.0, soc: 0, energyKwh: 0.00, cost: 0 },
  },
  single_preparing: {
    gunA: { status: 'Preparing', powerKw: 0.0, voltage: 380, current: 0.0, soc: 40, energyKwh: 0.00, cost: 0 },
    gunB: { status: 'Available', powerKw: 0.0, voltage: 0, current: 0.0, soc: 0, energyKwh: 0.00, cost: 0 },
  },
  standby: {
    gunA: { status: 'Available', powerKw: 0.0, voltage: 0, current: 0.0, soc: 0, energyKwh: 0.00, cost: 0 },
    gunB: { status: 'Available', powerKw: 0.0, voltage: 0, current: 0.0, soc: 0, energyKwh: 0.00, cost: 0 },
  },
};

const STORAGE_KEY = '@tesla_charge_simulator_scenario';

const SimulatorContext = createContext<SimulatorState>({
  scenario: 'live',
  isSimulating: false,
  gunA: DEFAULT_SCENARIOS.live.gunA,
  gunB: DEFAULT_SCENARIOS.live.gunB,
  setScenario: () => {},
});

export function SimulatorProvider({ children }: { children: React.ReactNode }) {
  const [scenario, setScenarioState] = useState<SimulatorScenario>('live');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((val) => {
      if (val && val in DEFAULT_SCENARIOS) {
        setScenarioState(val as SimulatorScenario);
      }
    });
  }, []);

  const setScenario = (sc: SimulatorScenario) => {
    setScenarioState(sc);
    AsyncStorage.setItem(STORAGE_KEY, sc).catch(() => {});
  };

  const data = DEFAULT_SCENARIOS[scenario] || DEFAULT_SCENARIOS.live;
  const isSimulating = scenario !== 'live';

  return (
    <SimulatorContext.Provider
      value={{
        scenario,
        isSimulating,
        gunA: data.gunA,
        gunB: data.gunB,
        setScenario,
      }}
    >
      {children}
    </SimulatorContext.Provider>
  );
}

export function useSimulator() {
  return useContext(SimulatorContext);
}
