import '../../ais/collisionPipeline.js';
import '../../simulation/dashboardScenario.js';
import { MARINA_DI_RAGUSA_SIM_DATA } from './marinaDiRagusaSimData';

const tools = (globalThis as any).RotevistaScenario((globalThis as any).RotevistaCollisionPipeline, MARINA_DI_RAGUSA_SIM_DATA);
export const generateRandomColregScenario = tools.generateRandomColregScenario;
export const recalculateArpaForTargets = tools.recalculateArpaForTargets;
