import { Application, Request, Response } from 'express';
import config from '../../config';
import logger from '../../logger';
import { handleError } from '../../utils/api';
import freebankApi, { FreebankResult, parseCreditId } from './freebank-api';
import creditActivity from './credit-activity';
import bmm from './bmm';
import custody, { CUSTODY_MAX_TXIDS } from './custody';
import { CREDIT_FAMILIES, CreditFamily } from './freebank-tx-parser';

// /api/v1/freebank/* - the FreeBank credit pages' API: read-only JSON, cached until the next
// block (see freebank-api.ts). Rate limiting is nginx's, as for every /api/v1 route
// (nginx-mempool.conf `location /api/v1`); the backend adds none of its own.
//
//   GET houses        { tip_height, houses: listhouses }
//   GET house/:id     { tip_height, house: gethouse, loanbook: listloanbook <id>,
//                       bills: listbills with owner_house_id == id,
//                       pools: listpools with house_id == id }                    404 unknown
//   GET bills         { tip_height, bills: listbills }
//   GET bill/:id      { tip_height, bill: getbill }                               404 unknown
//   GET pools         { tip_height, pools: listpools }
//   GET pool/:id      { tip_height, pool: getpool, house: gethouse of pool.house_id } 404 unknown
//   GET gold          { tip_height, fix: getgoldfix or null, submitters: listoraclesubmitters }
//   GET activity?family=&limit=
//                     { tip_height, scanned_from_height, items: [ { txid, height, time,
//                       version, family, op, op_name, fee, decoded } ] }, newest first
//   GET summary       { tip_height, houses, houses_by_badge, minted_units_total,
//                       minted_grams_total, bills_active, loanbook_face_total,
//                       loanbook_face_total_grams, pools, gold_fix }
//
// The BMM view (bmm.ts): the eCash block, pool and bid behind each FreeBank block.
//   GET bmm?limit=&before=
//                     { enabled, explorer_url, tip_height, items: BmmBlock[] }, newest first,
//                     heights below `before` (default: from the tip); limit 1-100, default 25
//   GET bmm/block/:hash BmmBlock ('pending' if not looked up yet)             404 unknown
//   GET bmm/summary   { enabled, explorer_url, indexed, pending, carried, total_bid_sats,
//                       avg_bid_sats, median_bid_sats, last, pools, latest_ecash_height }
//
// Custody labels (custody.ts): the coins the credit rules hold, on inputs and outputs.
//   GET custody?txids=<txid>,<txid>,...   (1-25 txids)
//                     { tip_height, txs: { [txid]: { vin: [label|null], vout: [label|null],
//                       truncated? } | null } }; label = { kind, text, tooltip, link, and the
//                       ids it names }; null for a txid the node does not know
//
// A malformed id is a 400; an id the node does not know is a 404; a node failure is a 500
// with a short message. Nothing here throws past the handler.

const ACTIVITY_DEFAULT_LIMIT = 50;
const ACTIVITY_MAX_LIMIT = 200;
const ACTIVITY_WAIT_MS = 1500;
const BMM_DEFAULT_LIMIT = 25;
const BMM_MAX_LIMIT = 100;

function nodeError(req: Request, res: Response, what: string, e: unknown): void {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  logger.debug(`FreeBank API ${what}: ${message}`);
  handleError(req, res, 500, `FreeBank node error: ${message}`);
}

function send(res: Response, result: FreebankResult): void {
  res.status(result.status).json(result.body);
}

class FreebankRoutes {
  public initRoutes(app: Application): void {
    const prefix = config.MEMPOOL.API_URL_PREFIX + 'freebank/';
    app
      .get(prefix + 'houses', this.$getHouses)
      .get(prefix + 'house/:id', this.$getHouse)
      .get(prefix + 'bills', this.$getBills)
      .get(prefix + 'bill/:id', this.$getBill)
      .get(prefix + 'pools', this.$getPools)
      .get(prefix + 'pool/:id', this.$getPool)
      .get(prefix + 'gold', this.$getGold)
      .get(prefix + 'activity', this.$getActivity)
      .get(prefix + 'summary', this.$getSummary)
      .get(prefix + 'bmm', this.$getBmm)
      .get(prefix + 'bmm/block/:hash', this.$getBmmBlock)
      .get(prefix + 'bmm/summary', this.$getBmmSummary)
      .get(prefix + 'custody', this.$getCustody)
      ;
  }

  private $getHouses = async (req: Request, res: Response): Promise<void> => {
    try {
      send(res, await freebankApi.$getHouses());
    } catch (e) {
      nodeError(req, res, 'houses', e);
    }
  };

  private $getHouse = async (req: Request, res: Response): Promise<void> => {
    const id = parseCreditId(req.params.id);
    if (id === null) {
      handleError(req, res, 400, 'Invalid house id');
      return;
    }
    try {
      send(res, await freebankApi.$getHouse(id));
    } catch (e) {
      nodeError(req, res, 'house', e);
    }
  };

  private $getBills = async (req: Request, res: Response): Promise<void> => {
    try {
      send(res, await freebankApi.$getBills());
    } catch (e) {
      nodeError(req, res, 'bills', e);
    }
  };

  private $getBill = async (req: Request, res: Response): Promise<void> => {
    const id = parseCreditId(req.params.id);
    if (id === null) {
      handleError(req, res, 400, 'Invalid bill id');
      return;
    }
    try {
      send(res, await freebankApi.$getBill(id));
    } catch (e) {
      nodeError(req, res, 'bill', e);
    }
  };

  private $getPools = async (req: Request, res: Response): Promise<void> => {
    try {
      send(res, await freebankApi.$getPools());
    } catch (e) {
      nodeError(req, res, 'pools', e);
    }
  };

  private $getPool = async (req: Request, res: Response): Promise<void> => {
    const id = parseCreditId(req.params.id);
    if (id === null) {
      handleError(req, res, 400, 'Invalid pool id');
      return;
    }
    try {
      send(res, await freebankApi.$getPool(id));
    } catch (e) {
      nodeError(req, res, 'pool', e);
    }
  };

  private $getGold = async (req: Request, res: Response): Promise<void> => {
    try {
      send(res, await freebankApi.$getGold());
    } catch (e) {
      nodeError(req, res, 'gold', e);
    }
  };

  private $getSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      send(res, await freebankApi.$getSummary());
    } catch (e) {
      nodeError(req, res, 'summary', e);
    }
  };

  private $getActivity = async (req: Request, res: Response): Promise<void> => {
    const familyParam = typeof req.query.family === 'string' ? req.query.family : '';
    let family: CreditFamily | null = null;
    if (familyParam !== '') {
      if (!(CREDIT_FAMILIES as readonly string[]).includes(familyParam)) {
        handleError(req, res, 400, `Unknown family: expected one of ${CREDIT_FAMILIES.join(', ')}`);
        return;
      }
      family = familyParam as CreditFamily;
    }
    const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitParam)
      ? Math.min(ACTIVITY_MAX_LIMIT, Math.max(1, limitParam))
      : ACTIVITY_DEFAULT_LIMIT;

    try {
      // let a block that just arrived (or replaced the tip at the same height) make it into
      // the answer
      const tip = await freebankApi.$getTip();
      await creditActivity.$waitForTip(tip, ACTIVITY_WAIT_MS);
      const range = creditActivity.getRange();
      // The answer covers blocks scanned_from_height..tip_height (the index's own top, which
      // trails the node's only while it catches up); empty when scanned_from_height > tip_height.
      const indexed = range.top >= 0;
      res.json({
        tip_height: indexed ? range.top : tip.height,
        scanned_from_height: indexed ? range.scannedFrom : tip.height + 1,
        items: creditActivity.getItems(family, limit),
      });
    } catch (e) {
      nodeError(req, res, 'activity', e);
    }
  };

  private $getBmm = async (req: Request, res: Response): Promise<void> => {
    const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitParam)
      ? Math.min(BMM_MAX_LIMIT, Math.max(1, limitParam))
      : BMM_DEFAULT_LIMIT;
    let before: number | null = null;
    if (typeof req.query.before === 'string' && req.query.before !== '') {
      if (!/^[0-9]{1,10}$/.test(req.query.before)) {
        handleError(req, res, 400, 'Invalid before: expected a block height');
        return;
      }
      before = parseInt(req.query.before, 10);
    }
    try {
      res.json(await bmm.$getList(limit, before));
    } catch (e) {
      nodeError(req, res, 'bmm', e);
    }
  };

  private $getBmmBlock = async (req: Request, res: Response): Promise<void> => {
    const hash = String(req.params.hash).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      handleError(req, res, 400, 'Invalid block hash');
      return;
    }
    try {
      const item = await bmm.$getBlock(hash);
      if (item === null) {
        handleError(req, res, 404, 'Block not found');
        return;
      }
      res.json(item);
    } catch (e) {
      nodeError(req, res, 'bmm block', e);
    }
  };

  private $getBmmSummary = (req: Request, res: Response): void => {
    res.json(bmm.getSummary());
  };

  private $getCustody = async (req: Request, res: Response): Promise<void> => {
    const txids = typeof req.query.txids === 'string' ? req.query.txids.toLowerCase().split(',') : [];
    if (!txids.length || txids.length > CUSTODY_MAX_TXIDS || !txids.every((txid) => /^[0-9a-f]{64}$/.test(txid))) {
      handleError(req, res, 400, `Invalid txids: expected 1 to ${CUSTODY_MAX_TXIDS} txids, separated by commas`);
      return;
    }
    try {
      res.json(await custody.$getCustody(txids));
    } catch (e) {
      nodeError(req, res, 'custody', e);
    }
  };
}

export default new FreebankRoutes();
