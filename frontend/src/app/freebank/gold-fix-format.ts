import { UNIT } from '@app/app.constants';
import { formatEcx, formatGrams, goldFixGramsPerEcx } from '@app/freebank/credit-units';

// The gold fix as a visitor reads it. Pure TypeScript (no Angular).
//
// The node stores the price as MILLIGRAMS OF GOLD PER 1000 ECX (freebank src/oracle.h, getgoldfix
// help): getgoldfix raw / braked and the oracle submit payload's price_mg all use that unit. The
// same number divided by 1,000,000 is grams of gold per ECX: 800000000 -> 800 g per ECX. Its
// inverse is the ECX (or sats) one gram of gold costs at the fix: 1e14 / value sats per gram.
//
// The fix is consensus-inert in this phase (oracle.h "INERT BY DESIGN"; getgoldfix help:
// "nothing in the credit rules reads them"). It is also NOT the presentation scale behind the
// *_grams fields, which is a fixed launch constant (getgramrate).

const gramsPerEcxFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });
const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const smallSatsFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A usable fix value: a positive finite number (the node never stores 0). */
export function isGoldFixValue(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value) && value > 0;
}

/** Grams of gold per ECX without the 'per ECX': 800000000 -> '800 g', 20735647 -> '20.736 g'; below 1 g in mg. */
export function formatGoldFixGrams(mgPer1000Ecx: number): string {
  if (!isGoldFixValue(mgPer1000Ecx)) {
    return '';
  }
  const grams = goldFixGramsPerEcx(mgPer1000Ecx);
  return grams >= 1 ? gramsPerEcxFormat.format(grams) + ' g' : formatGrams(grams);
}

/** '800 g per ECX' */
export function formatGoldFixPrice(mgPer1000Ecx: number): string {
  const grams = formatGoldFixGrams(mgPer1000Ecx);
  return grams ? `${grams} per ${UNIT}` : '';
}

/** The stored integer, grouped: 800000000 -> '800,000,000' */
export function formatGoldFixStored(mgPer1000Ecx: number): string {
  return isGoldFixValue(mgPer1000Ecx) ? integerFormat.format(mgPer1000Ecx) : '';
}

/** Sats that buy one gram of gold at this price: 800000000 -> 125000. Null for a missing value. */
export function goldFixSatsPerGram(mgPer1000Ecx: number): number | null {
  return isGoldFixValue(mgPer1000Ecx) ? 1e14 / mgPer1000Ecx : null;
}

/** '125,000 sats' (two decimals below 100 sats) */
export function formatGoldFixSatsPerGram(mgPer1000Ecx: number): string {
  const sats = goldFixSatsPerGram(mgPer1000Ecx);
  if (sats === null) {
    return '';
  }
  return (sats >= 100 ? integerFormat.format(sats) : smallSatsFormat.format(sats)) + ' szats';
}

/** ECX that buys one gram of gold at this price: 800000000 -> '0.00125 ECX' */
export function formatGoldFixEcxPerGram(mgPer1000Ecx: number): string {
  return isGoldFixValue(mgPer1000Ecx) ? `${formatEcx(1e6 / mgPer1000Ecx)} ${UNIT}` : '';
}
