import type { Density } from "./settings";

export interface DensityMetrics {
  rowH: number;
  indent: number;
  gap: number;
  headerH: number;
  sectionGap: number;
  controlH: number;
  base: number;
  pillLeft: number;
  pillRight: number;
}

const shared = { base: 28, pillLeft: 8, pillRight: 6 };
const metrics: Record<Density, DensityMetrics> = {
  compact: { ...shared, rowH: 28, indent: 14, gap: 6, headerH: 26, sectionGap: 10, controlH: 28 },
  default: { ...shared, rowH: 32, indent: 16, gap: 8, headerH: 30, sectionGap: 16, controlH: 32 },
  "two-line": { ...shared, rowH: 48, indent: 16, gap: 8, headerH: 30, sectionGap: 18, controlH: 32 },
};

export function densityMetrics(density: Density): DensityMetrics {
  return metrics[density];
}
