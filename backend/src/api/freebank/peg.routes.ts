import { Application, Request, Response } from 'express';
import config from '../../config';
import logger from '../../logger';
import { handleError } from '../../utils/api';
import bitcoinClient from '../bitcoin/bitcoin-client';
import freebankApi, { Tip } from './freebank-api';
import pegIndex, { pegExplorerUrl } from './peg-index';
import { PegListType, PegTxView, PegWithdrawalView } from './peg.interfaces';

// /api/v1/freebank/peg* - FreeBank's two-way peg with eCash (peg-index.ts): deposits from
// eCash, withdrawals to eCash, withdrawal bundles and refunds. Read-only JSON; every answer
// carries explorer_url (FREEBANK.BMM_EXPLORER_URL), the eCash explorer to link eCash txs and
// blocks to. Amounts in szats; hashes in display order.
//
//   GET peg/summary          PegSummary: the eCash treasury, counts, the bundle waiting on eCash
//   GET pegs?type=&limit=    PegList: type deposit | withdrawal | bundle, newest first;
//                            limit 1-200, default 25
//   GET peg/tx/:txid         PegTxView: the tx's peg outputs with their status, and the node's
//                            getwithdrawal for each withdrawal it names                404 none
//   GET peg/block/:hash      PegBlockView: the block's peg events (empty lists when none) 404 unknown
//   GET peg/ecash-tx/:txid   PegEcashTxView: the FreeBank block that recorded an eCash deposit
//                            or bundle payment                                         404 unknown
//   GET withdrawal/:id       PegWithdrawalView: the withdrawal, its bundle, and the node's
//                            getwithdrawal                                             404 unknown
//
// A malformed id is a 400; a node failure is a 500 with a short message.

const LIST_DEFAULT_LIMIT = 25;
const LIST_MAX_LIMIT = 200;
const WAIT_MS = 1500;
const LIST_TYPES: readonly PegListType[] = ['deposit', 'withdrawal', 'bundle'];
const HASH_RE = /^[0-9a-f]{64}$/;

function nodeError(req: Request, res: Response, what: string, e: unknown): void {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 200);
  logger.debug(`FreeBank peg API ${what}: ${message}`);
  handleError(req, res, 500, `FreeBank node error: ${message}`);
}

/** The node's answer for a hash or txid it does not know (RPC_INVALID_ADDRESS_OR_KEY). */
function isNotFound(e: any): boolean {
  return e?.code === -5 || /not found|no such/i.test(e?.message ?? '');
}

function hashParam(req: Request, name: string): string | null {
  const value = String(req.params[name] ?? '').toLowerCase();
  return HASH_RE.test(value) ? value : null;
}

/** Let a block that just arrived (or replaced the tip) into the answer. @asyncUnsafe */
async function $caughtUp(): Promise<Tip> {
  const tip = await freebankApi.$getTip();
  await pegIndex.$waitForTip(tip, WAIT_MS);
  return tip;
}

/**
 * The node's getwithdrawal for each withdrawal a tx view names: the eCash address in its eCash
 * form (the node decodes the carrier form) and the node's own status. Null when it cannot say.
 * @asyncSafe
 */
async function $addNodeWithdrawals(view: PegTxView, tip: Tip): Promise<void> {
  for (const out of view.outputs) {
    const id = out.output.kind === 'withdrawal' ? out.output.id : out.output.kind === 'refund-request' ? out.output.withdrawal_id : null;
    if (id) {
      out.node = await pegIndex.$getNodeWithdrawal(id, tip.hash).catch(() => null);
    }
  }
}

class PegRoutes {
  public initRoutes(app: Application): void {
    const prefix = config.MEMPOOL.API_URL_PREFIX + 'freebank/';
    app
      .get(prefix + 'peg/summary', this.$getSummary)
      .get(prefix + 'pegs', this.$getList)
      .get(prefix + 'peg/tx/:txid', this.$getTx)
      .get(prefix + 'peg/block/:hash', this.$getBlock)
      .get(prefix + 'peg/ecash-tx/:txid', this.$getEcashTx)
      .get(prefix + 'withdrawal/:id', this.$getWithdrawal)
      ;
  }

  private $getSummary = async (req: Request, res: Response): Promise<void> => {
    try {
      await $caughtUp();
      res.json(pegIndex.getSummary());
    } catch (e) {
      nodeError(req, res, 'summary', e);
    }
  };

  private $getList = async (req: Request, res: Response): Promise<void> => {
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    if (!(LIST_TYPES as readonly string[]).includes(type)) {
      handleError(req, res, 400, `Unknown type: expected one of ${LIST_TYPES.join(', ')}`);
      return;
    }
    const limitParam = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(limitParam) ? Math.min(LIST_MAX_LIMIT, Math.max(1, limitParam)) : LIST_DEFAULT_LIMIT;
    try {
      await $caughtUp();
      res.json(pegIndex.getList(type as PegListType, limit));
    } catch (e) {
      nodeError(req, res, 'list', e);
    }
  };

  private $getTx = async (req: Request, res: Response): Promise<void> => {
    const txid = hashParam(req, 'txid');
    if (!txid) {
      handleError(req, res, 400, 'Invalid txid');
      return;
    }
    try {
      const tip = await $caughtUp();
      const indexed = pegIndex.getTx(txid);
      if (indexed) {
        await $addNodeWithdrawals(indexed, tip);
        res.json(indexed);
        return;
      }
      // not in the index: unconfirmed, in a block the index has not reached, or a coinbase whose
      // only peg output is the current-bundle commitment
      let tx: any;
      try {
        tx = await bitcoinClient.getRawTransaction(txid, true);
      } catch (e) {
        if (isNotFound(e)) {
          handleError(req, res, 404, 'Transaction not found');
          return;
        }
        throw e;
      }
      let block: { height: number, hash: string } | null = null;
      if (typeof tx?.blockhash === 'string') {
        const header = await bitcoinClient.getBlockHeader(tx.blockhash, true);
        block = { height: header.height, hash: tx.blockhash };
      }
      const view = pegIndex.describeTx(
        txid,
        (tx?.vout || []).map((o: any) => ({ scriptpubkey: o?.scriptPubKey?.hex || '' })),
        typeof tx?.vin?.[0]?.coinbase === 'string',
        block,
      );
      if (!view) {
        handleError(req, res, 404, 'No FreeBank peg outputs in this transaction');
        return;
      }
      await $addNodeWithdrawals(view, tip);
      res.json(view);
    } catch (e) {
      nodeError(req, res, 'tx', e);
    }
  };

  private $getBlock = async (req: Request, res: Response): Promise<void> => {
    const hash = hashParam(req, 'hash');
    if (!hash) {
      handleError(req, res, 400, 'Invalid block hash');
      return;
    }
    try {
      let header: any;
      try {
        header = await bitcoinClient.getBlockHeader(hash, true);
      } catch (e) {
        if (isNotFound(e)) {
          handleError(req, res, 404, 'Block not found');
          return;
        }
        throw e;
      }
      await $caughtUp();
      res.json(pegIndex.getBlock(hash, header.height, header.confirmations >= 0));
    } catch (e) {
      nodeError(req, res, 'block', e);
    }
  };

  private $getEcashTx = async (req: Request, res: Response): Promise<void> => {
    const txid = hashParam(req, 'txid');
    if (!txid) {
      handleError(req, res, 400, 'Invalid txid');
      return;
    }
    try {
      await $caughtUp();
      const view = pegIndex.getEcashTx(txid);
      if (!view) {
        handleError(req, res, 404, 'No FreeBank block recorded this eCash transaction');
        return;
      }
      res.json(view);
    } catch (e) {
      nodeError(req, res, 'ecash-tx', e);
    }
  };

  private $getWithdrawal = async (req: Request, res: Response): Promise<void> => {
    const id = hashParam(req, 'id');
    if (!id) {
      handleError(req, res, 400, 'Invalid withdrawal id');
      return;
    }
    try {
      const tip = await freebankApi.$getTip();
      await pegIndex.$waitForTip(tip, WAIT_MS);
      const { withdrawal, bundle } = pegIndex.getWithdrawal(id);
      const node = await pegIndex.$getNodeWithdrawal(id, tip.hash);
      if (!withdrawal && !node) {
        handleError(req, res, 404, 'Withdrawal not found');
        return;
      }
      const view: PegWithdrawalView = {
        explorer_url: pegExplorerUrl(),
        tip_height: pegIndex.getTop(),
        withdrawal,
        bundle,
        node,
      };
      res.json(view);
    } catch (e) {
      nodeError(req, res, 'withdrawal', e);
    }
  };
}

export default new PegRoutes();
