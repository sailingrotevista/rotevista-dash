import data from '../../simulation/dashboardMarina.json';
import { AisTarget, HarborCluster } from '../types';
export const MARINA_DI_RAGUSA_SIM_DATA = data as unknown as {
  myGps: { lat: number; lon: number }; targets: AisTarget[]; harborClusters: HarborCluster[];
};
