import { FreebankBmmBlock, FreebankBmmStatus } from '@interfaces/freebank-bmm.interface';
import { formatUnits } from '@app/freebank/credit-units';

// Display helpers for the BMM view (/bmm, the block page's "Carried by eCash block" row and the
// bid on the block cubes).
// Pure TypeScript. Links to the eCash explorer are built here from the explorer_url the API
// sends; the browser never fetches anything from that host, it only links to it.
// Bids are in szats, the eCash subunit's name, which FreeBank uses too (operator, 2026-09-25).

const rateFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shareFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** Plain words for a block that is not 'ok' ('' for ok). */
const STATUS_TEXT: Record<FreebankBmmStatus, string> = {
  'ok': '',
  'pending': 'waiting for the eCash explorer',
  'error': 'waiting for the eCash explorer',
  'no-mainchain-block': 'eCash block not found',
  'no-commitment': 'no commitment found',
  'no-bid': 'no bid found',
};

const STATUS_HELP: Record<FreebankBmmStatus, string> = {
  'ok': '',
  'pending': 'Not looked up on the eCash explorer yet. The lookups run one at a time, so a long chain takes a while.',
  'error': 'The eCash explorer did not answer. The lookup is tried again later.',
  'no-mainchain-block': 'The eCash explorer does not have the eCash block this FreeBank block names. It may belong to another chain, such as a test chain.',
  'no-commitment': 'The eCash block this FreeBank block names does not commit to it: no BMM accept for FreeBank\'s slot in its coinbase.',
  'no-bid': 'The eCash block commits to this FreeBank block, but holds no bid transaction for it.',
};

/** Not looked up yet, or the last lookup failed: the backend will try again. */
export function bmmWaiting(status: FreebankBmmStatus): boolean {
  return status === 'pending' || status === 'error';
}

export function bmmStatusText(status: FreebankBmmStatus): string {
  return STATUS_TEXT[status] ?? 'unknown';
}

export function bmmStatusHelp(status: FreebankBmmStatus): string {
  return STATUS_HELP[status] ?? '';
}

/**
 * A link into the eCash explorer: ecashExplorerUrl('https://explorer.beta.ecash.ninja/', 'block', hash)
 * -> 'https://explorer.beta.ecash.ninja/block/<hash>'. Null without an http(s) base or an id.
 */
export function ecashExplorerUrl(base: string, path: 'block' | 'tx' | 'mining/pool', id: string): string | null {
  if (!base || !id || !/^https?:\/\//i.test(base)) {
    return null;
  }
  return base.replace(/\/+$/, '') + '/' + path + '/' + encodeURIComponent(id);
}

/** The explorer's host name for text: 'https://explorer.beta.ecash.ninja' -> 'explorer.beta.ecash.ninja'. */
export function ecashExplorerHost(base: string): string {
  const match = /^https?:\/\/([^/?#]+)/i.exec(base || '');
  return match ? match[1] : '';
}

/** 'f73fb242…9f9d' */
export function shortTxid(txid: string): string {
  if (!txid) {
    return '';
  }
  return txid.length > 14 ? txid.slice(0, 8) + '…' + txid.slice(-4) : txid;
}

/** 2000 -> '2,000' (no unit) */
export function formatBidSats(sats: number | null): string {
  return typeof sats === 'number' ? formatUnits(sats) : '';
}

/** 2.656 -> '2.66' (szat/vB, no unit) */
export function formatBidRate(rate: number | null): string {
  return typeof rate === 'number' && isFinite(rate) ? rateFormat.format(rate) : '';
}

/** 0.6667 -> '66.7%' */
export function formatShare(share: number): string {
  return typeof share === 'number' && isFinite(share) ? shareFormat.format(share * 100) + '%' : '';
}

/** One BmmBlock read for display. */
export interface BmmRow {
  item: FreebankBmmBlock;
  ok: boolean;
  waiting: boolean;
  statusHelp: string;
  ecashNote: string;              // the status words, shown in the eCash column when the eCash block is unknown
  bidNote: string;                // the status words, shown in the bid column when the eCash block is known
  ecashBlockUrl: string | null;   // only when the eCash explorer has the block
  poolUrl: string | null;
  bidTxUrl: string | null;
  bidTxShort: string;
  bidText: string;                // '2,000'
  rateText: string;               // '2.66'
}

export function bmmRow(item: FreebankBmmBlock, explorerUrl: string): BmmRow {
  const ok = item.status === 'ok';
  const text = ok ? '' : bmmStatusText(item.status);
  const ecashKnown = typeof item.ecash_height === 'number';
  return {
    item,
    ok,
    waiting: bmmWaiting(item.status),
    statusHelp: bmmStatusHelp(item.status),
    ecashNote: ecashKnown ? '' : text,
    bidNote: ecashKnown ? text : '',
    ecashBlockUrl: ecashKnown ? ecashExplorerUrl(explorerUrl, 'block', item.ecash_hash) : null,
    poolUrl: item.pool?.slug ? ecashExplorerUrl(explorerUrl, 'mining/pool', item.pool.slug) : null,
    bidTxUrl: item.bid_txid ? ecashExplorerUrl(explorerUrl, 'tx', item.bid_txid) : null,
    bidTxShort: shortTxid(item.bid_txid),
    bidText: formatBidSats(item.bid_sats),
    rateText: formatBidRate(item.bid_rate),
  };
}

/** What a block cube in the header strip shows from the BMM view (BmmCubesService). */
export interface BmmCube {
  bidText: string;                // the cube's big line: '2,000 szats', or 'bid …' while pending
  poolName: string;               // the badge under the cube; '' for none
  poolUrl: string | null;         // the pool's page on the eCash explorer
}

/**
 * The cube for one block: the bid once the backend has found it ('ok'), 'bid …' while the backend
 * will still look (pending, or a failed lookup it retries), and null for every final status other
 * than 'ok' (the cube then shows what it shows without the view).
 */
export function bmmCube(item: FreebankBmmBlock, explorerUrl: string): BmmCube | null {
  if (bmmWaiting(item.status)) {
    return { bidText: 'bid …', poolName: '', poolUrl: null };
  }
  if (item.status !== 'ok' || typeof item.bid_sats !== 'number') {
    return null;
  }
  return {
    bidText: formatBidSats(item.bid_sats) + ' szats',
    poolName: item.pool?.name || item.pool?.slug || '',
    poolUrl: item.pool?.slug ? ecashExplorerUrl(explorerUrl, 'mining/pool', item.pool.slug) : null,
  };
}

/** Older/Newer paging over heights, newest first. `before` shows only heights below it. */
export interface BmmPaging {
  newer: boolean;
  newerBefore: number | null;     // the newer page's `before`; null for the newest page
  older: boolean;
  olderBefore: number | null;
}

/**
 * The page asks for pageSize + 1 items: a full answer means there are older blocks.
 * `shown` is what the page lists (at most pageSize, newest first).
 */
export function bmmPaging(shown: FreebankBmmBlock[], received: number, pageSize: number, before: number | null, tipHeight: number): BmmPaging {
  const top = shown.length ? shown[0].freebank_height : (before ?? tipHeight + 1) - 1;
  const bottom = shown.length ? shown[shown.length - 1].freebank_height : null;
  let newerBefore: number | null = top + pageSize + 1;
  if (newerBefore > tipHeight) {
    newerBefore = null;
  }
  const older = bottom !== null && bottom > 0 && received > pageSize;
  return {
    newer: before !== null && top < tipHeight,
    newerBefore,
    older,
    olderBefore: older ? bottom : null,
  };
}

/** ?before=1234 -> 1234; anything else (missing, 0, junk) -> null (the newest page). */
export function parseBmmBefore(value: string | null): number | null {
  if (!value || !/^[0-9]+$/.test(value)) {
    return null;
  }
  const n = parseInt(value, 10);
  return n > 0 ? n : null;
}
