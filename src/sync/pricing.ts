/**
 * Fat-rate bands. Keep this rule identical to mobile/src/utils/fat-bands.ts.
 *
 * Inclusive ranges. A shared boundary is an overlap and is rejected.
 * A gap matches no band and is not given a guessed rate.
 * Once the business has at least one active band, a new milk entry must name
 * that band and the rate currently on it. If the phone has an older rate,
 * the entry is rejected and left for review. It is not rewritten.
 * An entry that was already saved keeps its rate when the fat percentage
 * does not change, even if the band's rate is edited later.
 * If the business has no active band yet, a legacy entry is stored with the
 * rate the phone already calculated.
 */

export interface FatBandRecord {
  uuid: string;
  min_fat: number;
  max_fat: number;
  rate_per_liter: number;
  effective_from: string;
  effective_to: string | null;
  active: number;
}

const OPEN_END = '9999-12-31';

export function lineAmount(liters: number, ratePerLiter: number): number {
  if (!Number.isFinite(liters) || !Number.isFinite(ratePerLiter)) return 0;
  return Math.round(liters * ratePerLiter * 100) / 100;
}

export function bandsConflict(candidate: FatBandRecord, others: FatBandRecord[]): boolean {
  if (candidate.active !== 1) return false;
  if (candidate.min_fat > candidate.max_fat) return true;
  if (candidate.effective_to && candidate.effective_from > candidate.effective_to) return true;
  const aEnd = candidate.effective_to ?? OPEN_END;
  return others.some((other) => {
    if (other.uuid === candidate.uuid || other.active !== 1) return false;
    const fatOverlaps = candidate.min_fat <= other.max_fat && other.min_fat <= candidate.max_fat;
    const bEnd = other.effective_to ?? OPEN_END;
    const dateOverlaps = candidate.effective_from <= bEnd && other.effective_from <= aEnd;
    return fatOverlaps && dateOverlaps;
  });
}

export type MilkDecision =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string };

export function decideMilkUpsert(input: {
  data: Record<string, unknown>;
  existing: Record<string, unknown> | null;
  bands: FatBandRecord[];
  shiftTaken: boolean;
  assigned: boolean;
}): MilkDecision {
  if (!input.assigned) {
    return { ok: false, reason: 'This dairy is not assigned to you.' };
  }
  if (input.shiftTaken) {
    return { ok: false, reason: 'A collection for this dairy, date, and shift already exists.' };
  }

  const liters = Number(input.data.liters);
  const fat = Number(input.data.fat_percentage);
  const date = String(input.data.date ?? '');
  const active = input.bands.filter((band) => band.active === 1);

  if (input.existing && Math.abs(Number(input.existing.fat_percentage) - fat) < 0.0001) {
    const rate = Number(input.existing.rate_per_liter);
    return {
      ok: true,
      data: {
        ...input.data,
        rate_per_liter: rate,
        total_amount: lineAmount(liters, rate),
        pricing_band_uuid: (input.existing.pricing_band_uuid as string | null | undefined) ?? null,
      },
    };
  }

  if (active.length === 0) {
    return { ok: true, data: input.data };
  }

  const matches = active.filter(
    (band) =>
      fat >= band.min_fat &&
      fat <= band.max_fat &&
      date >= band.effective_from &&
      date <= (band.effective_to ?? OPEN_END)
  );
  if (matches.length === 0) {
    return {
      ok: false,
      reason: 'No fat-rate band covers this fat on this date. Nothing was guessed.',
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: 'More than one fat-rate band matches. The owner must fix the rate table.',
    };
  }

  const band = matches[0];
  const clientBand = typeof input.data.pricing_band_uuid === 'string' ? input.data.pricing_band_uuid : '';
  const clientRate = Number(input.data.rate_per_liter);
  if (!clientBand || clientBand !== band.uuid || Math.abs(clientRate - band.rate_per_liter) > 0.009) {
    return {
      ok: false,
      reason: `The fat rate on this phone does not match the owner's table (Rs ${band.rate_per_liter} per liter). Sync, review the rate, and save again. It was not applied silently.`,
    };
  }

  return {
    ok: true,
    data: {
      ...input.data,
      rate_per_liter: band.rate_per_liter,
      total_amount: lineAmount(liters, band.rate_per_liter),
      pricing_band_uuid: band.uuid,
    },
  };
}
