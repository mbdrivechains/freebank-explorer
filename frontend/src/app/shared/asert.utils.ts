import { selectPowerOfTen } from '@app/bitcoin.utils';

// easynet: number formats for the ASERT figures (the mining page's ASERT section and both difficulty cards).

/** Core's GetDifficulty for an nBits. */
export function difficultyFromBits(bits: number): number {
  let shift = (bits >>> 24) & 0xff;
  let diff = 0x0000ffff / (bits & 0x00ffffff);
  while (shift < 29) {
    diff *= 256;
    shift++;
  }
  while (shift > 29) {
    diff /= 256;
    shift--;
  }
  return diff;
}

export function formatDifficulty(d: number | null | undefined): string {
  if (d === null || d === undefined || !isFinite(d)) {
    return '–';
  }
  if (d >= 1000) {
    const p = selectPowerOfTen(d);
    return (d / p.divider).toFixed(2) + ' ' + p.unit;
  }
  return Number(d.toPrecision(5)).toString();
}

export function formatHashrate(h: number | null | undefined): string {
  if (h === null || h === undefined || !isFinite(h) || h <= 0) {
    return '–';
  }
  const p = selectPowerOfTen(h);
  return (h / p.divider).toFixed(2) + ' ' + p.unit + 'H/s';
}

/** A duration in seconds, short: 45s, 12m 05s, 3h 05m, 2d 4h. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !isFinite(seconds)) {
    return '–';
  }
  const s = Math.round(Math.abs(seconds));
  if (s < 60) {
    return `${s}s`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }
  if (s < 172800) {
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
