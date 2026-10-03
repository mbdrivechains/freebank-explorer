// FreeBank asset coins on transaction lists (v0.2.18 assets): which inputs and outputs carry an asset's units or its
// control, from GET /api/v1/freebank/asset-coins (the backend's asset index, api/freebank/asset-index.ts). A coin's
// units are its value in szats; the asset's decimals say where the display point goes. Pure TypeScript, no Angular.

export type AssetCoinKind = 'units' | 'control';

/** GET /api/v1/freebank/asset-coins: one confirmed tx's asset coins. */
export interface FreebankAssetTxCoins {
  asset_id: string;
  ticker: string;
  decimals: number;
  genesis: boolean;
  invalid?: string;
  in: { txid: string, vout: number, kind: AssetCoinKind, units: number }[];
  out: { n: number, kind: AssetCoinKind, units: number, burn?: true }[];
}

export interface FreebankAssetCoinsResponse {
  tip_height: number;
  behind_by: number;
  txs: { [txid: string]: FreebankAssetTxCoins }; // txs that touch no asset are left out
}

export interface FreebankAssetLabel {
  asset_id: string;
  text: string; // '250.000 GOLD', 'GOLD control', '1,000 GOLD burned'
  tooltip: string;
}

/** Units in the asset's display form: 1234567 with decimals 3 is '1,234.567'. */
export function formatAssetUnits(units: number, decimals: number): string {
  const d = Number.isInteger(decimals) && decimals > 0 && decimals <= 8 ? decimals : 0;
  const negative = units < 0;
  const digits = String(Math.abs(Math.trunc(units))).padStart(d + 1, '0');
  const whole = digits.slice(0, digits.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = d ? '.' + digits.slice(digits.length - d) : '';
  return (negative ? '-' : '') + whole + frac;
}

function label(coins: FreebankAssetTxCoins, kind: AssetCoinKind, units: number, burn: boolean): FreebankAssetLabel {
  const ticker = coins.ticker || 'asset';
  const id = `asset ${coins.asset_id.slice(0, 8)}…`;
  if (kind === 'control') {
    return { asset_id: coins.asset_id, text: `${ticker} control`, tooltip: `The control coin of ${ticker} (${id}). Tickers are not unique: the asset is its id.` };
  }
  const amount = formatAssetUnits(units, coins.decimals);
  if (burn) {
    return { asset_id: coins.asset_id, text: `${amount} ${ticker} burned`, tooltip: `Sent to an unspendable output: these units of ${ticker} (${id}) are destroyed.` };
  }
  return {
    asset_id: coins.asset_id,
    text: `${amount} ${ticker}`,
    tooltip: `This coin carries ${amount} ${ticker} (${id}); its ECX value is the units in szats. Tickers are not unique: the asset is its id.`,
  };
}

/** The asset label of each input and output of a tx (undefined where it carries no asset). */
export function assetCoinLabels(
  tx: { vin: { txid?: string, vout?: number }[], vout: unknown[] },
  coins: FreebankAssetTxCoins | null | undefined,
): { vin: (FreebankAssetLabel | undefined)[], vout: (FreebankAssetLabel | undefined)[] } {
  const vin = (tx.vin || []).map((input) => {
    const c = coins?.in.find((x) => x.txid === input.txid && x.vout === input.vout);
    return c && coins ? label(coins, c.kind, c.units, false) : undefined;
  });
  const vout = (tx.vout || []).map((_, n) => {
    const c = coins?.out.find((x) => x.n === n);
    return c && coins ? label(coins, c.kind, c.units, !!c.burn) : undefined;
  });
  return { vin, vout };
}
