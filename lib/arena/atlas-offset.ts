// Hidden-center v2 samples on the exchange's one-cent price grid.
export const LIMIT_BAND_CENTS = 500;
export const OFFSET_SCALE_CENTS = 100;
export const OFFSET_DEGREES_OF_FREEDOM = 1.5;
const weightPrecision = 1_000_000;

function makeCumulativeWeights(): number[] {
  const cumulative: number[] = [];
  let total = 0;
  for (let cents = -LIMIT_BAND_CENTS; cents <= LIMIT_BAND_CENTS; cents++) {
    const z = cents / OFFSET_SCALE_CENTS;
    const density = (1 + z * z / OFFSET_DEGREES_OF_FREEDOM) ** (-(OFFSET_DEGREES_OF_FREEDOM + 1) / 2);
    total += Math.round(weightPrecision * density);
    cumulative.push(total);
  }
  return cumulative;
}

const cumulativeWeights = makeCumulativeWeights();

// One existing uniform draw selects a tick. Changing the limit-price rule therefore
// preserves the center, arrival times, directions and sizes for a fixed secret/seed.
export function studentTOffset(draw: number): number {
  const target = Math.floor(draw * cumulativeWeights[cumulativeWeights.length - 1]);
  let lo = 0;
  let hi = cumulativeWeights.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (target < cumulativeWeights[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo - LIMIT_BAND_CENTS;
}
