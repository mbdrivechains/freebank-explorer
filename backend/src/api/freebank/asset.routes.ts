import { Application, Request, Response } from 'express';
import config from '../../config';
import logger from '../../logger';
import { handleError } from '../../utils/api';
import freebankApi, { Tip } from './freebank-api';
import assetIndex from './asset-index';

// /api/v1/freebank/asset* - FreeBank assets (v0.2.18, tx v10; asset-index.ts). Read-only JSON. Units are the asset's
// base units (a coin's value in szats); `decimals` says where the display point goes. An asset is its asset_id (the
// genesis txid): tickers are not unique. Every answer carries tip_height (the index's top) and behind_by.
//
//   GET assets                      { assets: every asset, oldest first: supply, burned, circulating, holders, ... }
//   GET asset/:id                   the asset, its holders (largest first, at most 100), where its control coin is,
//                                   and its newest 50 transactions                                       404 unknown
//   GET asset-holdings/:address     the asset coins an address holds now, per asset
//   GET asset-coins?txids=a,b,...   for up to 50 confirmed txs: the asset coins each spends (by outpoint) and
//                                   creates (by output index), with the asset's ticker and decimals; a tx that
//                                   touches no asset is left out
//
// A malformed id or address is a 400; a node failure, a 500.

const WAIT_MS = 1500;
const HASH_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^[0-9A-Za-z]{14,100}$/;
export const ASSET_COINS_MAX_TXIDS = 50;

/** @asyncUnsafe */
async function $caughtUp(): Promise<Tip> {
  const tip = await freebankApi.$getTip();
  await assetIndex.$waitForTip(tip, WAIT_MS);
  return tip;
}

function nodeError(req: Request, res: Response, what: string, e: unknown): void {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  logger.debug(`FreeBank asset API ${what}: ${message}`);
  handleError(req, res, 500, `FreeBank node error: ${message}`);
}

class AssetRoutes {
  public initRoutes(app: Application): void {
    const prefix = config.MEMPOOL.API_URL_PREFIX + 'freebank/';
    app
      .get(prefix + 'assets', this.$getList)
      .get(prefix + 'asset/:id', this.$getAsset)
      .get(prefix + 'asset-holdings/:address', this.$getHoldings)
      .get(prefix + 'asset-coins', this.$getTxCoins)
      ;
  }

  private $getList = async (req: Request, res: Response): Promise<void> => {
    try {
      const tip = await $caughtUp();
      res.json({ ...assetIndex.tipInfo(tip.height), assets: assetIndex.list() });
    } catch (e) {
      nodeError(req, res, 'list', e);
    }
  };

  private $getAsset = async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? '').toLowerCase();
    if (!HASH_RE.test(id)) {
      handleError(req, res, 400, 'Invalid asset id: expected the 64-hex genesis txid');
      return;
    }
    try {
      const tip = await $caughtUp();
      const asset = assetIndex.get(id);
      if (!asset) {
        handleError(req, res, 404, 'Asset not found');
        return;
      }
      res.json({ ...assetIndex.tipInfo(tip.height), asset });
    } catch (e) {
      nodeError(req, res, 'asset', e);
    }
  };

  private $getTxCoins = async (req: Request, res: Response): Promise<void> => {
    const list = typeof req.query.txids === 'string' ? req.query.txids.toLowerCase().split(',').filter((t) => t) : [];
    if (!list.length || list.length > ASSET_COINS_MAX_TXIDS || !list.every((t) => HASH_RE.test(t))) {
      handleError(req, res, 400, `txids: 1 to ${ASSET_COINS_MAX_TXIDS} comma-separated 64-hex txids`);
      return;
    }
    try {
      const tip = await $caughtUp();
      const txs: { [txid: string]: unknown } = {};
      for (const txid of new Set(list)) {
        const coins = assetIndex.txCoins(txid);
        if (coins) {
          txs[txid] = coins;
        }
      }
      res.json({ ...assetIndex.tipInfo(tip.height), txs });
    } catch (e) {
      nodeError(req, res, 'coins', e);
    }
  };

  private $getHoldings = async (req: Request, res: Response): Promise<void> => {
    const address = String(req.params.address ?? '');
    if (!ADDRESS_RE.test(address)) {
      handleError(req, res, 400, 'Invalid address');
      return;
    }
    try {
      const tip = await $caughtUp();
      res.json({ ...assetIndex.tipInfo(tip.height), address, holdings: assetIndex.holdings(address) });
    } catch (e) {
      nodeError(req, res, 'holdings', e);
    }
  };
}

export default new AssetRoutes();
