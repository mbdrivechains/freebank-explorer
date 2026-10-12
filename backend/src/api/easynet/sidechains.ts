import * as fs from 'fs';
import { Application, Request, Response } from 'express';
import config from '../../config';
import logger from '../../logger';
import bitcoinClient from '../bitcoin/bitcoin-client';
import { handleError } from '../../utils/api';
import {
  applyBlock, emptySidechainState, failsAtHeight, SIDECHAIN_RULES, SidechainProposal, SidechainRules, SidechainState,
} from './sidechain-rules';

const CACHE_VERSION = 1;
const SNAPSHOTS_KEPT = 30;   // states of the latest blocks, to step back over a reorg without a full replay
const SAVE_EVERY = 500;      // blocks, while catching up

/**
 * easynet: the sidechain slots (BIP 300 M1 proposals and M2 acks), replayed from every block's coinbase with the
 * enforcer's rules (sidechain-rules.ts). SIDECHAIN_RULES names the thresholds ('' = off); SIDECHAIN_START_HEIGHT is the
 * enforcer's BIP 300 activation height. The state is kept in the cache directory and follows reorgs.
 */
class SidechainIndex {
  private rules: SidechainRules | null = SIDECHAIN_RULES[config.MEMPOOL.SIDECHAIN_RULES] ?? null;
  private startHeight = config.MEMPOOL.SIDECHAIN_START_HEIGHT;
  private file = config.MEMPOOL.CACHE_DIR + '/easynet-sidechains.json';
  private state: SidechainState = emptySidechainState();
  private snapshots: string[] = [];   // JSON of the states after the latest blocks, oldest first
  private loaded = false;
  private running = false;
  private tipHeight = -1;

  public enabled(): boolean {
    return this.rules !== null;
  }

  /** Catch up with the node's tip (called from the main loop; one run at a time). @asyncSafe */
  public async $update(): Promise<void> {
    if (!this.rules || this.running) {
      return;
    }
    this.running = true;
    try {
      if (!this.loaded) {
        this.load();
        this.loaded = true;
      }
      const best: string = await bitcoinClient.getBestBlockHash();
      if (best === this.state.hash) {
        return;
      }
      // step back while our tip is not on the node's chain
      while (this.state.height >= 0 && await bitcoinClient.getBlockHash(this.state.height) !== this.state.hash) {
        this.stepBack();
      }
      this.tipHeight = await bitcoinClient.getBlockCount();
      let done = 0;
      while (this.state.height < this.tipHeight) {
        const height = this.state.height + 1;
        const hash: string = await bitcoinClient.getBlockHash(height);
        // the genesis coinbase cannot be fetched by txid, so block 0 comes with its transactions
        const block = await bitcoinClient.getBlock(hash, height === 0 ? 2 : 1);
        if (this.state.height >= 0 && block.previousblockhash !== this.state.hash) {
          break; // a reorg while catching up: the next run steps back
        }
        const coinbase = height === 0 ? block.tx[0] : await bitcoinClient.getRawTransaction(block.tx[0], true, hash);
        this.snapshots.push(JSON.stringify(this.state));
        if (this.snapshots.length > SNAPSHOTS_KEPT) {
          this.snapshots.shift();
        }
        applyBlock(this.state, this.rules, this.startHeight, {
          height, hash, coinbaseTxid: coinbase.txid,
          outputs: coinbase.vout.map((o: any) => ({ n: o.n, hex: o.scriptPubKey.hex })),
        });
        if (++done % SAVE_EVERY === 0) {
          this.save();
          logger.info(`Sidechain slots: replayed to block ${height} of ${this.tipHeight}`);
        }
      }
      if (done > 0) {
        this.save();
      }
    } catch (e) {
      logger.warn(`Sidechain slots: update failed (${e instanceof Error ? e.message : e})`);
    } finally {
      this.running = false;
    }
  }

  private stepBack(): void {
    const previous = this.snapshots.pop();
    if (previous) {
      this.state = JSON.parse(previous);
    } else {
      logger.notice(`Sidechain slots: block ${this.state.height} left the chain beyond the kept states; replaying from genesis`);
      this.state = emptySidechainState();
    }
  }

  private load(): void {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version === CACHE_VERSION && saved.rules === this.rules?.name && saved.startHeight === this.startHeight) {
        this.state = saved.state;
        logger.info(`Sidechain slots: loaded at block ${this.state.height}`);
      }
    } catch (e) {
      // no file yet, or unreadable: replay from genesis
    }
  }

  private save(): void {
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, rules: this.rules?.name, startHeight: this.startHeight, state: this.state }));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      logger.warn(`Sidechain slots: cannot save (${e instanceof Error ? e.message : e})`);
    }
  }

  private withWindow(p: SidechainProposal): any {
    const rules = this.rules as SidechainRules;
    const slotUsed = this.state.active[p.slot] !== undefined;
    const maxAge = slotUsed ? rules.usedMaxAge : rules.unusedMaxAge;
    const threshold = slotUsed ? rules.usedThreshold : rules.unusedThreshold;
    return {
      ...p,
      slotUsed,
      age: Math.max(0, this.state.height - p.height),
      acksNeeded: Math.max(0, threshold + 1 - p.votes),
      lastActivationHeight: p.height + maxAge,
      failsAtHeight: failsAtHeight(p, rules, slotUsed),
    };
  }

  public summary(): any {
    const rules = this.rules as SidechainRules;
    return {
      rules,
      startHeight: this.startHeight,
      height: this.state.height,
      tipHeight: Math.max(this.tipHeight, this.state.height),
      active: Object.keys(this.state.active).map((slot) => this.state.proposals[this.state.active[slot]])
        .sort((a, b) => a.slot - b.slot).map((p) => ({ ...p, ackHeights: undefined })),
      pending: this.state.pending.map((i) => this.withWindow(this.state.proposals[i]))
        .sort((a, b) => a.slot - b.slot || a.height - b.height).map((p) => ({ ...p, ackHeights: undefined })),
      events: this.state.events.slice(-100).reverse(),
    };
  }

  public slot(slot: number): any {
    const proposals = this.state.proposals.filter((p) => p.slot === slot).reverse()
      .map((p) => p.status === 'pending' ? this.withWindow(p) : p);
    const active = this.state.active[slot] !== undefined ? this.state.proposals[this.state.active[slot]] : null;
    return { rules: this.rules, height: this.state.height, slot, active, proposals };
  }

  public initRoutes(app: Application): void {
    app
      .get(config.MEMPOOL.API_URL_PREFIX + 'sidechains', this.$getSummary.bind(this))
      .get(config.MEMPOOL.API_URL_PREFIX + 'sidechains/:slot', this.$getSlot.bind(this));
  }

  private headers(res: Response): void {
    res.header('Pragma', 'public');
    res.header('Cache-control', 'public');
    res.setHeader('Expires', new Date(Date.now() + 1000 * 10).toUTCString());
  }

  private async $getSummary(req: Request, res: Response): Promise<void> {
    if (!this.rules) {
      handleError(req, res, 404, 'Sidechain slots are not enabled');
      return;
    }
    this.headers(res);
    res.json(this.summary());
  }

  private async $getSlot(req: Request, res: Response): Promise<void> {
    if (!this.rules) {
      handleError(req, res, 404, 'Sidechain slots are not enabled');
      return;
    }
    const slot = /^\d{1,3}$/.test(req.params.slot) ? parseInt(req.params.slot, 10) : -1;
    if (slot < 0 || slot > 255) {
      handleError(req, res, 400, 'A slot is a number from 0 to 255');
      return;
    }
    this.headers(res);
    res.json(this.slot(slot));
  }
}

export default new SidechainIndex();
