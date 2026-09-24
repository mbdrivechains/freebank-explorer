// FreeBank credit layer: unit conversions and number formatting for the credit pages.
// Units are documented in interfaces/freebank-credit.interface.ts. Pure TypeScript (no Angular),
// English formatting only. The pipes and <app-credit-amount> in this folder wrap these.

import { UNIT } from '@app/app.constants';

export const SATS_PER_ECX = 100000000;

const ecxFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
const cubeEcxFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const integerFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const grams2Format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mg1Format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const mg2Format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mg3Format = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const percentFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && isFinite(value);
}

/** sats -> ECX */
export function satsToEcx(sats: number): number {
  return sats / SATS_PER_ECX;
}

/** An ECX amount: 1 -> '1.00', 0.01955035 -> '0.01955035'. No unit suffix. */
export function formatEcx(ecx: number): string {
  return isNumber(ecx) ? ecxFormat.format(ecx) : '';
}

/** A sats amount shown in ECX: 1955035 -> '0.01955035'. No unit suffix. */
export function formatSatsAsEcx(sats: number): string {
  return isNumber(sats) ? ecxFormat.format(satsToEcx(sats)) : '';
}

/** Note units (or any integer count): 5040000 -> '5,040,000'. No unit suffix. */
export function formatUnits(units: number): string {
  return isNumber(units) ? integerFormat.format(units) : '';
}

/**
 * A sats amount on a block cube (fees, the BMM bid), with its unit: szats below 0.01 ECX, ECX from
 * there, so it fits the 125px cube: 0 -> '0 szats', 1 -> '1 szat', 125000 -> '125,000 szats',
 * 1955035 -> '0.02 ECX', 123456789 -> '1.235 ECX'.
 */
export function formatCubeAmount(sats: number): string {
  if (!isNumber(sats)) {
    return '';
  }
  if (sats < SATS_PER_ECX / 100) {
    return integerFormat.format(sats) + (sats === 1 ? ' szat' : ' szats');
  }
  return cubeEcxFormat.format(satsToEcx(sats)) + ' ' + UNIT;
}

/**
 * Grams of gold with the unit: 694.564952 -> '694.56 g', 1.045077 -> '1.05 g';
 * below one gram in milligrams (FreeBank's own denomination unit): 0.435449 -> '435.4 mg',
 * 0.007257 -> '7.26 mg', 0.000123 -> '0.123 mg'; 0 -> '0 g'.
 */
export function formatGrams(grams: number): string {
  if (!isNumber(grams)) {
    return '';
  }
  if (grams === 0) {
    return '0 g';
  }
  const abs = Math.abs(grams);
  if (abs >= 1) {
    return grams2Format.format(grams) + ' g';
  }
  const mg = grams * 1000;
  const absMg = abs * 1000;
  if (absMg >= 100) {
    return mg1Format.format(mg) + ' mg';
  }
  if (absMg >= 1) {
    return mg2Format.format(mg) + ' mg';
  }
  return mg3Format.format(mg) + ' mg';
}

/** Basis points as a percent: 10000 -> '100%', 1000 -> '10%', 30 -> '0.3%', 1 -> '0.01%'. */
export function formatBps(bps: number): string {
  return isNumber(bps) ? percentFormat.format(bps / 100) + '%' : '';
}

/** '1 block', '288 blocks', '1,008 blocks' */
export function formatBlockCount(blocks: number): string {
  if (!isNumber(blocks)) {
    return '';
  }
  return integerFormat.format(blocks) + (Math.abs(blocks) === 1 ? ' block' : ' blocks');
}

/** Signed distance of a height from the tip: > 0 is in the future, < 0 in the past. */
export function blocksFromTip(height: number, tipHeight: number): number {
  return height - tipHeight;
}

/** 'in 286 blocks', '2 blocks ago', 'at the tip' */
export function formatBlocksFromTip(height: number, tipHeight: number): string {
  if (!isNumber(height) || !isNumber(tipHeight)) {
    return '';
  }
  const diff = blocksFromTip(height, tipHeight);
  if (diff > 0) {
    return 'in ' + formatBlockCount(diff);
  }
  if (diff < 0) {
    return formatBlockCount(-diff) + ' ago';
  }
  return 'at the tip';
}

/**
 * The gold fix (getgoldfix raw / braked) is milligrams of gold per 1000 ECX, so
 * grams per ECX = value / 1,000,000. Example: 800000000 -> 800 g per ECX.
 */
export function goldFixGramsPerEcx(mgPer1000Ecx: number): number {
  return mgPer1000Ecx / 1000000;
}

/**
 * The node's presentation scale, grams per ECX, recovered from any ECX amount and its *_grams
 * twin (the API does not serve getgramrate). Use a large pair such as house.activeescrow and
 * house.activeescrow_grams: *_grams has 6 decimals, so small pairs are imprecise.
 * Returns null when the ECX amount is 0 or missing.
 */
export function gramsPerEcxFrom(ecx: number, grams: number): number | null {
  if (!isNumber(ecx) || !isNumber(grams) || ecx === 0) {
    return null;
  }
  return grams / ecx;
}

/** Pool spot price in sats per note unit (spot_price_sats_x1e8 / 1e8); null when absent. */
export function poolSpotSatsPerUnit(spotPriceSatsX1e8: number | undefined): number | null {
  return isNumber(spotPriceSatsX1e8) ? spotPriceSatsX1e8 / 100000000 : null;
}
