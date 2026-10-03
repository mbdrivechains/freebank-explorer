import bitcoinClient from '../bitcoin/bitcoin-client';
import { houseBadge, HOUSE_BADGES } from './house-badge';
import {
  FreebankBill, FreebankGoldFix, FreebankHouse, FreebankLoanBook, FreebankOracleSubmitter,
  FreebankPool, FreebankSummary, HouseBadgeCounts,
} from './freebank.interfaces';

// The data behind /api/v1/freebank/*: the node's read-only credit RPCs (listhouses, gethouse,
// listbills, getbill, listloanbook, listpools, getpool, getgoldfix, listoraclesubmitters),
// composed per the API contract and cached until the chain tip changes.
//
// Credit state only moves with blocks (the RPCs read the chain-state trees, and the derived
// house status is computed at the tip), so a response is valid for as long as the best block
// hash is the same. The tip is looked up at most once a second (shared by concurrent
// requests), and the new-block callback in index.ts clears everything at once.

export interface FreebankResult {
  status: 200 | 404;
  body: any;
}

export interface Tip {
  height: number;
  hash: string;
}

const TIP_MEMO_MS = 1000;
// Bounds the per-tip cache: /house/:id etc. take any id, and every miss costs node calls.
const CACHE_MAX_ENTRIES = 500;
// Ids are uint32 on the node, but its RPCs read them with get_int() (int32).
const MAX_RPC_ID = 2147483647;

/** A decimal id the node's RPCs can take, or null. */
export function parseCreditId(raw: string): number | null {
  if (!/^[0-9]{1,10}$/.test(raw)) {
    return null;
  }
  const id = parseInt(raw, 10);
  return id <= MAX_RPC_ID ? id : null;
}

/** The node's answer for an id it does not know: RPC_MISC_ERROR "Unknown house!" etc. */
function isUnknownIdError(e: any): boolean {
  return /^unknown (house|bill|pool)/i.test(e?.message ?? '');
}

function notFound(what: string): FreebankResult {
  return { status: 404, body: { error: `${what} not found` } };
}

function ok(body: any): FreebankResult {
  return { status: 200, body };
}

class FreebankApi {
  private tipMemo: { at: number, promise: Promise<Tip> } | null = null;
  private cacheTipHash: string | null = null;
  private cache = new Map<string, Promise<FreebankResult>>();

  /** New block: drop the memoized tip and every cached response. */
  public onNewBlock(): void {
    this.tipMemo = null;
    this.cacheTipHash = null;
    this.cache.clear();
  }

  /** The best block (hash and height), looked up at most once a second. */
  public $getTip(): Promise<Tip> {
    const now = Date.now();
    if (this.tipMemo && now - this.tipMemo.at < TIP_MEMO_MS) {
      return this.tipMemo.promise;
    }
    const promise = this.$fetchTip();
    const memo = { at: now, promise };
    this.tipMemo = memo;
    promise.catch(() => {
      if (this.tipMemo === memo) {
        this.tipMemo = null;
      }
    });
    return promise;
  }

  /**
   * Hash first, then that block's height: the pair always describes the same block.
   * @asyncUnsafe
   */
  private async $fetchTip(): Promise<Tip> {
    const hash: string = await bitcoinClient.getBestBlockHash();
    const header = await bitcoinClient.getBlockHeader(hash, true);
    return { hash, height: header.height };
  }

  /** @asyncUnsafe */
  private async $cached(key: string, compute: (tip: Tip) => Promise<FreebankResult>): Promise<FreebankResult> {
    const tip = await this.$getTip();
    if (this.cacheTipHash !== tip.hash) {
      this.cache.clear();
      this.cacheTipHash = tip.hash;
    }
    const hit = this.cache.get(key);
    if (hit) {
      return hit;
    }
    const promise = compute(tip);
    if (this.cache.size < CACHE_MAX_ENTRIES) {
      this.cache.set(key, promise);
      // node errors are not cached (404s are results, and are)
      promise.catch(() => {
        if (this.cache.get(key) === promise) {
          this.cache.delete(key);
        }
      });
    }
    return promise;
  }

  // Each $getX answers from the cache or computes with $computeX; the $computeX methods may
  // reject on a node error, which the routes turn into a 500.

  public $getHouses(): Promise<FreebankResult> {
    return this.$cached('houses', (tip) => this.$computeHouses(tip));
  }

  public $getHouse(id: number): Promise<FreebankResult> {
    return this.$cached(`house:${id}`, (tip) => this.$computeHouse(tip, id));
  }

  public $getBills(): Promise<FreebankResult> {
    return this.$cached('bills', (tip) => this.$computeBills(tip));
  }

  public $getBill(id: number): Promise<FreebankResult> {
    return this.$cached(`bill:${id}`, (tip) => this.$computeBill(tip, id));
  }

  public $getPools(): Promise<FreebankResult> {
    return this.$cached('pools', (tip) => this.$computePools(tip));
  }

  public $getPool(id: number): Promise<FreebankResult> {
    return this.$cached(`pool:${id}`, (tip) => this.$computePool(tip, id));
  }

  public $getGold(): Promise<FreebankResult> {
    return this.$cached('gold', (tip) => this.$computeGold(tip));
  }

  public $getSummary(): Promise<FreebankResult> {
    return this.$cached('summary', (tip) => this.$computeSummary(tip));
  }

  /** @asyncUnsafe */
  private async $computeHouses(tip: Tip): Promise<FreebankResult> {
    const houses: FreebankHouse[] = await bitcoinClient.listHouses();
    return ok({ tip_height: tip.height, houses });
  }

  /** @asyncUnsafe */
  private async $computeHouse(tip: Tip, id: number): Promise<FreebankResult> {
    let house: FreebankHouse;
    try {
      house = await bitcoinClient.getHouse(id);
    } catch (e) {
      if (isUnknownIdError(e)) {
        return notFound('House');
      }
      throw e;
    }
    const [loanbook, bills, pools] = await Promise.all([
      bitcoinClient.listLoanBook(id) as Promise<FreebankLoanBook>,
      bitcoinClient.listBills() as Promise<FreebankBill[]>,
      bitcoinClient.listPools() as Promise<FreebankPool[]>,
    ]);
    return ok({
      tip_height: tip.height,
      house,
      loanbook,
      bills: bills.filter((b) => b.owner_house_id === id),
      pools: pools.filter((p) => p.house_id === id),
    });
  }

  /** @asyncUnsafe */
  private async $computeBills(tip: Tip): Promise<FreebankResult> {
    const bills: FreebankBill[] = await bitcoinClient.listBills();
    return ok({ tip_height: tip.height, bills });
  }

  /** @asyncUnsafe */
  private async $computeBill(tip: Tip, id: number): Promise<FreebankResult> {
    try {
      const bill: FreebankBill = await bitcoinClient.getBill(id);
      return ok({ tip_height: tip.height, bill });
    } catch (e) {
      if (isUnknownIdError(e)) {
        return notFound('Bill');
      }
      throw e;
    }
  }

  /** @asyncUnsafe */
  private async $computePools(tip: Tip): Promise<FreebankResult> {
    const pools: FreebankPool[] = await bitcoinClient.listPools();
    return ok({ tip_height: tip.height, pools });
  }

  /** @asyncUnsafe */
  private async $computePool(tip: Tip, id: number): Promise<FreebankResult> {
    let pool: FreebankPool;
    try {
      pool = await bitcoinClient.getPool(id);
    } catch (e) {
      if (isUnknownIdError(e)) {
        return notFound('Pool');
      }
      throw e;
    }
    let house: FreebankHouse | null = null;
    try {
      house = await bitcoinClient.getHouse(pool.house_id);
    } catch (e) {
      if (!isUnknownIdError(e)) {
        throw e;
      }
    }
    return ok({ tip_height: tip.height, pool, house });
  }

  /** @asyncUnsafe */
  private async $computeGold(tip: Tip): Promise<FreebankResult> {
    const [fix, submitters] = await Promise.all([
      bitcoinClient.getGoldFix() as Promise<FreebankGoldFix | null>,
      bitcoinClient.listOracleSubmitters() as Promise<FreebankOracleSubmitter[]>,
    ]);
    // null before the first fix ever forms (a normal state, not an error)
    return ok({ tip_height: tip.height, fix: fix || null, submitters });
  }

  /** @asyncUnsafe */
  private async $computeSummary(tip: Tip): Promise<FreebankResult> {
    const [houses, bills, loanbook, pools, fix] = await Promise.all([
      bitcoinClient.listHouses() as Promise<FreebankHouse[]>,
      bitcoinClient.listBills() as Promise<FreebankBill[]>,
      bitcoinClient.listLoanBook() as Promise<FreebankLoanBook>, // no argument: every house's book
      bitcoinClient.listPools() as Promise<FreebankPool[]>,
      bitcoinClient.getGoldFix() as Promise<FreebankGoldFix | null>,
    ]);
    const housesByBadge = {} as HouseBadgeCounts;
    for (const badge of HOUSE_BADGES) {
      housesByBadge[badge] = 0;
    }
    let mintedUnits = 0;
    let mintedGrams = 0;
    let gramsSent = false; // v0.2.17 dropped every *_grams field: report grams only when the node sends them
    for (const house of houses) {
      housesByBadge[houseBadge(house, tip.height).badge]++;
      mintedUnits += house.mintedunits || 0;
      if (typeof house.mintedunits_grams === 'number') {
        gramsSent = true;
        mintedGrams += house.mintedunits_grams;
      }
    }
    const summary: FreebankSummary = {
      tip_height: tip.height,
      houses: houses.length,
      houses_by_badge: housesByBadge,
      minted_units_total: mintedUnits,
      bills_active: bills.filter((b) => b.status === 'a').length, // bill.h BILL_STATUS_ACTIVE
      loanbook_face_total: loanbook.face_total,
      pools: pools.length,
      gold_fix: fix || null,
    };
    if (gramsSent) {
      summary.minted_grams_total = Math.round(mintedGrams * 1e6) / 1e6; // the node prints grams to 6 places
    }
    if (typeof loanbook.face_total_grams === 'number') {
      summary.loanbook_face_total_grams = loanbook.face_total_grams;
    }
    return ok(summary);
  }
}

export default new FreebankApi();
