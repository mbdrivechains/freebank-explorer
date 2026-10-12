import config from '../config';
import logger from '../logger';
import { IDifficultyAdjustment } from '../mempool.interfaces';
import blocks from './blocks';
import bitcoinApi from './bitcoin/bitcoin-api-factory';
import DB from '../database';

export interface DifficultyAdjustment {
  progressPercent: number;       // Percent: 0 to 100
  difficultyChange: number;      // Percent: -75 to 300
  estimatedRetargetDate: number; // Unix time in ms
  remainingBlocks: number;       // Block count
  remainingTime: number;         // Duration of time in ms
  previousRetarget: number;      // Percent: -75 to 300
  previousTime: number;          // Unix time in ms
  nextRetargetHeight: number;    // Block Height
  timeAvg: number;               // Duration of time in ms
  adjustedTimeAvg;               // Expected block interval with hashrate implied over last 504 blocks
  timeOffset: number;            // (Testnet) Time since last block (cap @ 20min) in ms
  expectedBlocks: number;         // Block count
  asert?: AsertInfo | null;      // easynet: above the ASERT anchor, the per-block difficulty (the fields above are then moot)
}

// easynet: ASERT (aserti3-2d, as in ABC and eCash; ecash-com/bitcoin PR #2). Above the anchor height every block's
// target is set from the anchor block's target and how far the chain is ahead of or behind a 10-minute schedule,
// counted from the anchor's parent:
//   target(h) = anchor target * 2^((time(h-1) - time(anchor parent) - 600 * (h-1 - anchor + 1)) / half-life)
// computed here exactly as consensus does (integer arithmetic, the cubic approximation of 2^x, compact bits), so the
// figures equal the node's. The testnet 20-minute rule still lets a block 20 minutes after its parent be mined at the
// minimum difficulty; such a block does not move the ASERT schedule.
export interface AsertInfo {
  anchorHeight: number;
  halfLife: number;          // seconds
  tipDifficulty: number;     // the tip's ASERT difficulty (what a normal block at its height needed)
  nextDifficulty: number;    // what the next normal block needs: fixed once the tip is known
  nextBits: number;          // its compact target (nBits)
  nextChange: number;        // percent, next vs tip
  scheduleOffset: number;    // seconds; > 0: the chain is behind its 10-minute schedule (difficulty falls), < 0: ahead
  timeAvg: number;           // ms, average block time over the last timeAvgBlocks blocks
  timeAvgBlocks: number;
}

export interface AsertAnchor {
  height: number;
  hash: string;
  bits: number;              // the anchor block's nBits
  parentTime: number;        // the anchor's parent's timestamp: ASERT's clock starts there
  powLimitBits: number;      // the proof-of-work limit as compact bits (ASERT_POW_LIMIT_BITS, else the genesis nBits)
}

/** easynet: one block of the ASERT page's series (GET /api/v1/mining/asert). */
export interface AsertBlock {
  height: number;
  hash: string;
  time: number;              // block timestamp, seconds
  interval: number | null;   // seconds since its parent's timestamp (can be negative: timestamps need not rise)
  bits: number;
  difficulty: number;
  expectedBits: number | null;   // above the anchor: what ASERT asks of a normal block at this height
  minDifficulty: boolean;    // mined at the minimum difficulty under the 20-minute rule (its bits are not ASERT's)
  scheduleOffset: number | null; // above the anchor: seconds behind (> 0) or ahead (< 0) of the 10-minute schedule
  txCount: number;
  pool: string | null;
}

const BLOCK_SPACING = 600n;

/** Core's arith_uint256::SetCompact (no negative or overflow targets reach here). */
export function targetFromBits(bits: number): bigint {
  const size = bits >>> 24;
  const word = BigInt(bits & 0x007fffff);
  return size <= 3 ? word >> BigInt(8 * (3 - size)) : word << BigInt(8 * (size - 3));
}

/** Core's arith_uint256::GetCompact. */
export function bitsFromTarget(target: bigint): number {
  let size = target === 0n ? 0 : target.toString(16).length + 1 >> 1;
  let compact = size <= 3 ? Number(target << BigInt(8 * (3 - size))) : Number(target >> BigInt(8 * (size - 3)));
  if (compact & 0x00800000) {
    compact >>= 8;
    size++;
  }
  return (compact | (size << 24)) >>> 0;
}

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

/** CalculateASERT (aserti3-2d): the nBits of the block at `height` whose parent has timestamp `prevTime`. */
export function asertBits(anchor: AsertAnchor, height: number, prevTime: number, halfLife: number): number {
  const powLimit = targetFromBits(anchor.powLimitBits);
  const timeDiff = BigInt(prevTime - anchor.parentTime);
  const heightDiff = BigInt(height - 1 - anchor.height);
  const exponent = ((timeDiff - BLOCK_SPACING * (heightDiff + 1n)) * 65536n) / BigInt(halfLife); // truncates, as C++
  let shifts = exponent >> 16n;           // arithmetic shift (floor), as in consensus
  const frac = exponent & 0xffffn;
  const factor = 65536n + ((195766423245049n * frac + 971821376n * frac * frac + 5127n * frac * frac * frac + (1n << 47n)) >> 48n);
  let next = targetFromBits(anchor.bits) * factor;
  shifts -= 16n;
  // consensus shifts a 256-bit number and takes powLimit on overflow; a BigInt cannot overflow, and anything that big
  // is above powLimit, so the clamp below gives the same
  next = shifts <= 0n ? next >> -shifts : next << shifts;
  if (next === 0n) {
    next = 1n;
  } else if (next > powLimit) {
    next = powLimit;
  }
  return bitsFromTarget(next);
}

/** ASERT figures for a tip above the anchor; `recent` holds the latest blocks in height order, ending at the tip. */
export function calcAsert(anchor: AsertAnchor, halfLife: number, recent: { height: number, timestamp: number }[]): AsertInfo | null {
  const tip = recent[recent.length - 1];
  if (!tip || tip.height <= anchor.height) {
    return null;
  }
  const parent = recent.find((b) => b.height === tip.height - 1);
  const nextBits = asertBits(anchor, tip.height + 1, tip.timestamp, halfLife);
  const nextDifficulty = difficultyFromBits(nextBits);
  const tipDifficulty = parent ? difficultyFromBits(asertBits(anchor, tip.height, parent.timestamp, halfLife)) : NaN;
  // the run of consecutive heights that ends at the tip
  let first = recent.length - 1;
  while (first > 0 && recent[first - 1].height === recent[first].height - 1) {
    first--;
  }
  const span = tip.height - recent[first].height;
  return {
    anchorHeight: anchor.height,
    halfLife,
    tipDifficulty,
    nextDifficulty,
    nextBits,
    nextChange: tipDifficulty > 0 ? (nextDifficulty / tipDifficulty - 1) * 100 : 0,
    scheduleOffset: tip.timestamp - anchor.parentTime - 600 * (tip.height - anchor.height + 1),
    timeAvg: span > 0 ? Math.round((tip.timestamp - recent[first].timestamp) / span * 1000) : 0,
    timeAvgBlocks: span,
  };
}

/**
 * Calculate the difficulty increase/decrease by using the `bits` integer contained in two
 * block headers.
 *
 * Warning: Only compare `bits` from blocks in two adjacent difficulty periods. This code
 * assumes the maximum difference is x4 or /4 (as per the protocol) and will throw an
 * error if an exponent difference of 2 or more is seen.
 *
 * @param {number} oldBits The 32 bit `bits` integer from a block header.
 * @param {number} newBits The 32 bit `bits` integer from a block header in the next difficulty period.
 * @returns {number} A floating point decimal of the difficulty change from old to new.
 *          (ie. 21.3 means 21.3% increase in difficulty, -21.3 is a 21.3% decrease in difficulty)
 */
export function calcBitsDifference(oldBits: number, newBits: number): number {
  // Must be
  // - integer
  // - highest exponent is 0x20, so max value (as integer) is 0x207fffff
  // - min value is 1 (exponent = 0)
  // - highest bit of the number-part is +- sign, it must not be 1
  const verifyBits = (bits: number): void => {
    if (
      Math.floor(bits) !== bits ||
      bits > 0x207fffff ||
      bits < 1 ||
      (bits & 0x00800000) !== 0 ||
      (bits & 0x007fffff) === 0
    ) {
      throw new Error('Invalid bits');
    }
  };
  verifyBits(oldBits);
  verifyBits(newBits);

  // No need to mask exponents because we checked the bounds above
  const oldExp = oldBits >> 24;
  const newExp = newBits >> 24;
  const oldNum = oldBits & 0x007fffff;
  const newNum = newBits & 0x007fffff;
  // The diff can only possibly be 1, 0, -1
  // (because maximum difficulty change is x4 or /4 (2 bits up or down))
  let result: number;
  switch (newExp - oldExp) {
    // New less than old, target lowered, difficulty increased
    case -1:
      result = ((oldNum << 8) * 100) / newNum - 100;
      break;
    // Same exponent, compare numbers as is.
    case 0:
      result = (oldNum * 100) / newNum - 100;
      break;
    // Old less than new, target raised, difficulty decreased
    case 1:
      result = (oldNum * 100) / (newNum << 8) - 100;
      break;
    default:
      throw new Error('Impossible exponent difference');
  }

  // Min/Max values
  return result > 300 ? 300 : result < -75 ? -75 : result;
}

export function calcDifficultyAdjustment(
  DATime: number,
  quarterEpochTime: number | null,
  nowSeconds: number,
  blockHeight: number,
  previousRetarget: number,
  network: string,
  latestBlockTimestamp: number,
): DifficultyAdjustment {
  const EPOCH_BLOCK_LENGTH = 2016; // Bitcoin mainnet
  const BLOCK_SECONDS_TARGET = 600; // Bitcoin mainnet
  const TESTNET_MAX_BLOCK_SECONDS = 1200; // Bitcoin testnet

  const diffSeconds = Math.max(0, nowSeconds - DATime);
  const blocksInEpoch = (blockHeight >= 0) ? blockHeight % EPOCH_BLOCK_LENGTH : 0;
  const progressPercent = (blockHeight >= 0) ? blocksInEpoch / EPOCH_BLOCK_LENGTH * 100 : 100;
  const remainingBlocks = EPOCH_BLOCK_LENGTH - blocksInEpoch;
  const nextRetargetHeight = (blockHeight >= 0) ? blockHeight + remainingBlocks : 0;
  const expectedBlocks = diffSeconds / BLOCK_SECONDS_TARGET;
  const actualTimespan = (blocksInEpoch === 2015 ? latestBlockTimestamp : nowSeconds) - DATime;

  let difficultyChange = 0;
  let timeAvgSecs = blocksInEpoch ? diffSeconds / blocksInEpoch : BLOCK_SECONDS_TARGET;
  let adjustedTimeAvgSecs = timeAvgSecs;

  // for the first 504 blocks of the epoch, calculate the expected avg block interval
  // from a sliding window over the last 504 blocks
  if (quarterEpochTime && blocksInEpoch < 503) {
    const timeLastEpoch = DATime - quarterEpochTime;
    const adjustedTimeLastEpoch = timeLastEpoch * (1 + (previousRetarget / 100));
    const adjustedTimeSpan = diffSeconds + adjustedTimeLastEpoch;
    adjustedTimeAvgSecs = adjustedTimeSpan / 503;
    difficultyChange = (BLOCK_SECONDS_TARGET / (adjustedTimeSpan / 504) - 1) * 100;
  } else {
    difficultyChange = (BLOCK_SECONDS_TARGET / (actualTimespan / (blocksInEpoch + 1)) - 1) * 100;
  }

  // Max increase is x4 (+300%)
  if (difficultyChange > 300) {
    difficultyChange = 300;
  }
  // Max decrease is /4 (-75%)
  if (difficultyChange < -75) {
    difficultyChange = -75;
  }

  // Testnet difficulty is set to 1 after 20 minutes of no blocks,
  // therefore the time between blocks will always be below 20 minutes (1200s).
  let timeOffset = 0;
  if (network === 'testnet') {
    if (timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeAvgSecs = TESTNET_MAX_BLOCK_SECONDS;
    }

    const secondsSinceLastBlock = nowSeconds - latestBlockTimestamp;
    if (secondsSinceLastBlock + timeAvgSecs > TESTNET_MAX_BLOCK_SECONDS) {
      timeOffset = -Math.min(secondsSinceLastBlock, TESTNET_MAX_BLOCK_SECONDS) * 1000;
    }
  }

  const timeAvg = Math.floor(timeAvgSecs * 1000);
  const adjustedTimeAvg = Math.floor(adjustedTimeAvgSecs * 1000);
  const remainingTime = remainingBlocks * adjustedTimeAvg;
  const estimatedRetargetDate = remainingTime + nowSeconds * 1000;

  return {
    progressPercent,
    difficultyChange,
    estimatedRetargetDate,
    remainingBlocks,
    remainingTime,
    previousRetarget,
    previousTime: DATime,
    nextRetargetHeight,
    timeAvg,
    adjustedTimeAvg,
    timeOffset,
    expectedBlocks,
  };
}

class DifficultyAdjustmentApi {
  private asertAnchor: AsertAnchor | null = null;
  private asertLoadedAt = 0;
  private asertLoading = false;
  private powLimitBits: number | null = null;

  /** easynet: the proof-of-work limit (ASERT_POW_LIMIT_BITS, else the genesis block's bits: right only while genesis
   *  sits at the limit) and, for a height above 0, the ASERT anchor block and its parent from the node; again every
   *  10 minutes, so a reorg across the anchor or a chain reset is picked up. @asyncSafe */
  private async $loadAsertAnchor(height: number): Promise<void> {
    if (this.asertLoading) {
      return;
    }
    this.asertLoading = true;
    try {
      this.powLimitBits = config.MEMPOOL.ASERT_POW_LIMIT_BITS
        || (await bitcoinApi.$getBlock(await bitcoinApi.$getBlockHash(0))).bits;
      if (height <= 0) {
        return; // only the proof-of-work limit: the anchor is not mined yet
      }
      const hash = await bitcoinApi.$getBlockHash(height);
      const anchor = await bitcoinApi.$getBlock(hash);
      const parent = await bitcoinApi.$getBlock(anchor.previousblockhash);
      this.asertAnchor = { height, hash, bits: anchor.bits, parentTime: parent.timestamp, powLimitBits: this.powLimitBits };
      this.asertLoadedAt = Date.now();
    } catch (e) {
      logger.warn(`ASERT anchor ${height}: cannot read it from the node (${e instanceof Error ? e.message : e})`);
    } finally {
      this.asertLoading = false;
    }
  }

  /**
   * easynet: the last `count` blocks for the ASERT page (plus `extra` earlier ones, for the hashrate windows), from the
   * explorer's database, with each block's interval and, above the anchor, ASERT's expected bits and schedule offset.
   * @asyncUnsafe
   */
  public async $getAsertBlocks(count: number, extra: number): Promise<{
    tipHeight: number, anchorHeight: number, halfLife: number, powLimitBits: number | null, anchor: AsertAnchor | null,
    blocks: AsertBlock[],
  }> {
    const anchorHeight = config.MEMPOOL.ASERT_ANCHOR_HEIGHT;
    const tipHeight = blocks.getCurrentBlockHeight();
    const anchorExists = anchorHeight > 0 && tipHeight >= anchorHeight;
    if (this.powLimitBits === null || (anchorExists && this.asertAnchor?.height !== anchorHeight)) {
      await this.$loadAsertAnchor(anchorExists ? anchorHeight : 0);
    }
    const anchor = anchorExists && this.asertAnchor?.height === anchorHeight ? this.asertAnchor : null;
    const from = Math.max(0, tipHeight - count - extra + 1);
    const [rows]: any[] = await DB.query(
      `SELECT blocks.height, blocks.hash, UNIX_TIMESTAMP(blocks.blockTimestamp) AS time, blocks.bits, blocks.difficulty,
              blocks.tx_count AS txCount, pools.name AS pool
         FROM blocks LEFT JOIN pools ON pools.id = blocks.pool_id
        WHERE blocks.stale = 0 AND blocks.height BETWEEN ? AND ?
        ORDER BY blocks.height`, [Math.max(0, from - 1), tipHeight]);
    const out: AsertBlock[] = [];
    let prev: any = null;
    for (const r of rows) {
      const height = Number(r.height);
      const time = Number(r.time);
      const parent = prev && Number(prev.height) === height - 1 ? prev : null;
      const above = anchor !== null && height > anchor.height;
      const expectedBits = above && parent ? asertBits(anchor, height, Number(parent.time), config.MEMPOOL.ASERT_HALF_LIFE) : null;
      if (height >= from) {
        out.push({
          height, hash: r.hash, time,
          interval: parent ? time - Number(parent.time) : null,
          bits: Number(r.bits),
          difficulty: Number(r.difficulty),
          expectedBits,
          minDifficulty: expectedBits !== null && Number(r.bits) !== expectedBits && Number(r.bits) === this.powLimitBits,
          scheduleOffset: above ? time - anchor.parentTime - 600 * (height - anchor.height + 1) : null,
          txCount: Number(r.txCount),
          pool: r.pool ?? null,
        });
      }
      prev = r;
    }
    return { tipHeight, anchorHeight, halfLife: config.MEMPOOL.ASERT_HALF_LIFE, powLimitBits: this.powLimitBits, anchor, blocks: out };
  }

  public getDifficultyAdjustment(): IDifficultyAdjustment | null {
    const DATime = blocks.getLastDifficultyAdjustmentTime();
    const previousRetarget = blocks.getPreviousDifficultyRetarget();
    const blockHeight = blocks.getCurrentBlockHeight();
    const blocksCache = blocks.getBlocks();
    const latestBlock = blocksCache[blocksCache.length - 1];
    if (!latestBlock) {
      return null;
    }
    const nowSeconds = Math.floor(new Date().getTime() / 1000);
    const quarterEpochBlockTime = blocks.getQuarterEpochBlockTime();

    const da: IDifficultyAdjustment = calcDifficultyAdjustment(
      DATime, quarterEpochBlockTime, nowSeconds, blockHeight, previousRetarget,
      config.MEMPOOL.NETWORK, latestBlock.timestamp
    );
    // easynet: above the ASERT anchor the difficulty is set every block; say so instead of a 2016-block estimate
    const anchorHeight = config.MEMPOOL.ASERT_ANCHOR_HEIGHT;
    if (anchorHeight > 0 && latestBlock.height > anchorHeight) {
      if (!this.asertAnchor || this.asertAnchor.height !== anchorHeight || Date.now() - this.asertLoadedAt > 600_000) {
        void this.$loadAsertAnchor(anchorHeight);
      }
      if (this.asertAnchor?.height === anchorHeight) {
        da.asert = calcAsert(this.asertAnchor, config.MEMPOOL.ASERT_HALF_LIFE,
          blocksCache.map((b) => ({ height: b.height, timestamp: b.timestamp })));
      }
    }
    return da;
  }
}

export default new DifficultyAdjustmentApi();
