import * as fs from 'fs';
import * as path from 'path';
import { Common } from '../../api/common';
import { TransactionFlags } from '../../mempool.interfaces';
import { parseFreebankTx, FreebankParsedTx } from '../../api/freebank/freebank-tx-parser';
import {
  FREEBANK_TX_FLAGS, FREEBANK_CREDIT_FLAG_BY_VERSION, creditVersionFromFlags, getFreebankTxFlags, isCoinbaseCommitment, isOpReturnData, sameAddress,
} from '../../api/freebank/freebank-tx-flags';

// Goggles flags for FreeBank txs (api/freebank/freebank-tx-flags.ts), run on real txs of the
// explorer spike's regtest chain: every credit tx (v11-v17), plain v3 txs, a coinbase, and the two
// coinbases that pay a deposit from the mainchain. The chain has no withdrawal or refund request,
// so those are synthetic.
interface TxFixture { txid: string, height: number, version: number, family?: string, op_name?: string, hex: string }
interface DepositCoinbase { height: number, payout_vout: number, payout_address: string, hex: string }
const fixtures: { credit: TxFixture[], other: TxFixture[] } = require('./test-data/freebank-txs.json');
const depositCoinbases: DepositCoinbase[] = require('./test-data/freebank-deposit-coinbases.json').coinbases;

const FRONTEND = path.join(__dirname, '../../../../frontend/src/app');
const FREEBANK_KEYS = Object.keys(FREEBANK_TX_FLAGS);
const ALL_FREEBANK_BITS = Object.values(FREEBANK_TX_FLAGS).reduce((acc, bit) => acc | bit, 0n);
const FAMILY_BITS = Object.values(FREEBANK_CREDIT_FLAG_BY_VERSION).reduce((acc, bit) => acc | bit, 0n);
const PEG_BITS = FREEBANK_TX_FLAGS.deposit_from_ecash | FREEBANK_TX_FLAGS.withdrawal_to_ecash | FREEBANK_TX_FLAGS.withdrawal_refund;
const VERSION_BITS = TransactionFlags.v1 | TransactionFlags.v2 | TransactionFlags.v3;

// the node's script types (Core Solver, freebank script/standard.cpp) for the scripts in the fixtures,
// in the backend's names (bitcoin-api.ts translateScriptPubKeyType)
function isPushOnly(hex: string): boolean {
  let i = 0;
  while (i < hex.length) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    if (op > 0x60) {
      return false;
    }
    let len = 0;
    if (op >= 0x01 && op <= 0x4b) {
      len = op;
    } else if (op >= 0x4c && op <= 0x4e) {
      const n = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
      len = parseInt(hex.slice(i, i + n * 2).match(/../g)!.reverse().join(''), 16);
      i += n * 2;
    }
    i += len * 2;
  }
  return i === hex.length;
}
function scriptType(hex: string): string {
  if (/^76a914[0-9a-f]{40}88ac$/.test(hex)) { return 'p2pkh'; }
  if (/^a914[0-9a-f]{40}87$/.test(hex)) { return 'p2sh'; }
  if (/^0014[0-9a-f]{40}$/.test(hex)) { return 'v0_p2wpkh'; }
  if (/^0020[0-9a-f]{64}$/.test(hex)) { return 'v0_p2wsh'; }
  if (/^(21[0-9a-f]{66}|41[0-9a-f]{130})ac$/.test(hex)) { return 'p2pk'; }
  if (hex.startsWith('6a') && isPushOnly(hex.slice(2))) { return 'op_return'; }
  return 'nonstandard';
}

// an esplora-shaped tx, as bitcoin-api.ts $convertTransaction builds it (no prevouts)
function toEsplora(tx: FreebankParsedTx, addresses: { [vout: number]: string } = {}): any {
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    size: tx.size,
    weight: tx.strippedSize * 3 + tx.size,
    fee: 0,
    status: { confirmed: true },
    vin: tx.vin.map((vin) => ({
      is_coinbase: /^0{64}$/.test(vin.txid) && vin.vout === 0xffffffff,
      prevout: null,
      scriptsig: vin.scriptsig,
      scriptsig_asm: '',
      sequence: vin.sequence,
      txid: vin.txid,
      vout: vin.vout,
      witness: vin.witness,
      inner_redeemscript_asm: '',
      inner_witnessscript_asm: '',
    })),
    vout: tx.vout.map((vout, i) => ({
      value: vout.value,
      scriptpubkey: vout.scriptpubkey,
      scriptpubkey_asm: '',
      scriptpubkey_type: scriptType(vout.scriptpubkey),
      scriptpubkey_address: addresses[i] || '',
    })),
  };
}

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex');
const P2PKH = (n: number) => '76a914' + n.toString(16).padStart(40, '0') + '88ac';
const PREV_BLOCK_COMMIT = '6afd7ad1ef' + '11'.repeat(64);
const VERSION_COMMIT = '6aa7e67e1f00000020';
const WITNESS_COMMIT = '6a24aa21a9ed' + '22'.repeat(32);
// a deposit record: 'D', slot 130, then the destination address as a length-prefixed string
// the slot, the destination, the amount (8 bytes little-endian), then the rest of the record
const le64 = (n: number) => Buffer.from(BigInt.asUintN(64, BigInt(n)).toString(16).padStart(16, '0'), 'hex').reverse().toString('hex');
const depositRecord = (address: string, amount = 150_001_000) => '6aacdcf66f44' + '82' + (address.length).toString(16).padStart(2, '0') + hex(address)
  + le64(amount) + '00'.repeat(32);
const coinbase = (vout: { scriptpubkey: string, value?: number, scriptpubkey_address?: string }[]) => ({
  version: 3,
  vin: [{ is_coinbase: true }],
  vout: vout.map((o) => ({ value: 0, scriptpubkey_address: '', ...o })),
});
const ordinary = (scripts: string[], version = 3) => ({
  version,
  vin: [{ is_coinbase: false }],
  vout: scripts.map((scriptpubkey, i) => ({ scriptpubkey, value: i ? 0 : 1000, scriptpubkey_address: '' })),
});
const ADDR = 'XDPTdcwkAe8ToyugJaNxU8BXoLcyUVaZK5';
const BECH32 = 'fbkrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

describe('FreeBank Goggles flags', () => {
  describe('credit txs (v11-v17), real', () => {
    const credit = fixtures.credit;

    test('the fixtures cover every credit version', () => {
      expect([...new Set(credit.map((t) => t.version))].sort()).toEqual([11, 12, 13, 14, 15, 16, 17]);
    });

    test.each(credit.map((t): [string, TxFixture] => [`v${t.version} ${t.family} ${t.op_name} (${t.txid.slice(0, 12)})`, t]))(
      '%s: the credit bit and exactly its family bit, no version bit',
      (_label, t) => {
        const tx = toEsplora(parseFreebankTx(t.hex));
        const own = getFreebankTxFlags(tx);
        expect(own).toEqual(FREEBANK_TX_FLAGS.credit | FREEBANK_CREDIT_FLAG_BY_VERSION[t.version]);
        const flags = BigInt(Common.getTransactionFlags(tx, t.height));
        expect(flags & ALL_FREEBANK_BITS).toEqual(own);
        expect(flags & VERSION_BITS).toEqual(0n);
        expect(creditVersionFromFlags(flags)).toEqual(t.version);
      },
    );

    test('family bits follow freebank primitives/transaction.h (v14 is a term deposit)', () => {
      expect(FREEBANK_CREDIT_FLAG_BY_VERSION).toEqual({
        11: FREEBANK_TX_FLAGS.bill, 12: FREEBANK_TX_FLAGS.house, 13: FREEBANK_TX_FLAGS.note, 14: FREEBANK_TX_FLAGS.term_deposit,
        15: FREEBANK_TX_FLAGS.pool, 16: FREEBANK_TX_FLAGS.settlement, 17: FREEBANK_TX_FLAGS.oracle,
      });
      expect(getFreebankTxFlags({ version: 10, vin: [{}], vout: [] })).toEqual(0n); // BitAsset create, retired
    });
  });

  describe('plain txs and coinbases, real', () => {
    test.each(fixtures.other.map((t): [string, TxFixture] => [`v${t.version} at ${t.height} (${t.txid.slice(0, 12)})`, t]))(
      '%s: no FreeBank bit',
      (_label, t) => {
        const tx = toEsplora(parseFreebankTx(t.hex));
        expect(getFreebankTxFlags(tx)).toEqual(0n);
        expect(BigInt(Common.getTransactionFlags(tx, t.height)) & ALL_FREEBANK_BITS).toEqual(0n);
      },
    );

    test('a coinbase whose only OP_RETURN is its witness commitment is not flagged OP_RETURN', () => {
      const t = fixtures.other.find((o) => o.txid === 'dc1232ba54201b9d666c1f91841c738d2a9b736d0e76bfd9b8c87bff0528a535')!;
      const tx = toEsplora(parseFreebankTx(t.hex));
      expect(tx.vin[0].is_coinbase).toBe(true);
      expect(tx.vout.filter((o) => o.scriptpubkey_type === 'op_return').map((o) => o.scriptpubkey.slice(0, 12))).toEqual(['6a24aa21a9ed']);
      expect(BigInt(Common.getTransactionFlags(tx, t.height)) & TransactionFlags.op_return).toEqual(0n);
    });

    test.each(depositCoinbases.map((c): [number, DepositCoinbase] => [c.height, c]))(
      'deposit coinbase at %i: Deposit from eCash, and no OP_RETURN',
      (_height, c) => {
        const tx = toEsplora(parseFreebankTx(c.hex), { [c.payout_vout]: c.payout_address });
        expect(tx.vin[0].is_coinbase).toBe(true);
        expect(tx.vout[c.payout_vout + 1].scriptpubkey.startsWith('6aacdcf66f44')).toBe(true);
        expect(getFreebankTxFlags(tx)).toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
        const flags = BigInt(Common.getTransactionFlags(tx, c.height));
        expect(flags & ALL_FREEBANK_BITS).toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
        expect(flags & TransactionFlags.op_return).toEqual(0n);
        expect(flags & TransactionFlags.batch_payout).toEqual(0n);
        // the node reports no address for the payout: nothing to match against the record
        expect(getFreebankTxFlags(toEsplora(parseFreebankTx(c.hex)))).toEqual(0n);
      },
    );
  });

  describe('deposits from eCash (a coinbase output pays the record its amount less the 1,000-szat fee)', () => {
    const payout = { scriptpubkey: P2PKH(1), value: 150_000_000, scriptpubkey_address: ADDR };
    const flagsOf = (vout) => getFreebankTxFlags(coinbase(vout));

    test('a payout right before its record', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { scriptpubkey: PREV_BLOCK_COMMIT }, payout, { scriptpubkey: depositRecord(ADDR) }]))
        .toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
    });
    test('a payout elsewhere in the coinbase (the node claims any output)', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: PREV_BLOCK_COMMIT }, { scriptpubkey: depositRecord(ADDR) }]))
        .toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
    });
    test('a bech32 destination may be spelled in capitals', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, scriptpubkey_address: BECH32 }, { scriptpubkey: depositRecord(BECH32.toUpperCase()) }]))
        .toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
    });
    test('a base58 destination in capitals is another address', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(ADDR.toUpperCase()) }])).toEqual(0n);
    });
    test('a record with no payout (a deposit that paid nothing)', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { scriptpubkey: VERSION_COMMIT }, { scriptpubkey: depositRecord(ADDR) }])).toEqual(0n);
    });
    test('a payout to another address than the record names (a refund payout)', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, scriptpubkey_address: 'XVx5H3pzuF8xRGJUap1ndQTw44kGvytY8P' },
        { scriptpubkey: depositRecord(ADDR) }])).toEqual(0n);
    });
    test('a payout of another amount', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, value: 150_001_000 }, { scriptpubkey: depositRecord(ADDR) }])).toEqual(0n);
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, value: 0 }, { scriptpubkey: depositRecord(ADDR) }])).toEqual(0n);
    });
    test('a deposit at or below the fee pays nothing', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, value: 0 }, { scriptpubkey: depositRecord(ADDR, 1000) }])).toEqual(0n);
    });
    test('an output pays one deposit only', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(ADDR) }, { scriptpubkey: depositRecord(ADDR) }]))
        .toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
    });
    test('a withdrawal bundle record is not a deposit', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, { ...payout, scriptpubkey_address: 'D' }, { scriptpubkey: depositRecord('D') }])).toEqual(0n);
    });
    test('the block reward output is never the payout', () => {
      expect(flagsOf([payout, { scriptpubkey: depositRecord(ADDR) }])).toEqual(0n);
    });
    test('a payout and record in an ordinary tx are not a deposit', () => {
      expect(getFreebankTxFlags({ version: 3, vin: [{ is_coinbase: false }], vout: [{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(ADDR) }] }))
        .toEqual(0n);
    });
    test('a cut-short record', () => {
      expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(ADDR).slice(0, 90) }])).toEqual(0n);
    });

    // the destination is the depositor's bytes; the node pays what DecodeDestination makes of them
    test('a base58 destination with C whitespace at either end, or cut by a NUL, is paid (base58.cpp)', () => {
      for (const dest of [ADDR + ' ', ' ' + ADDR, ADDR + '\n', '\t' + ADDR + '\r\n', '\v\f' + ADDR + ' \v', ADDR + '\0junk', ' ' + ADDR + ' \0 x', ADDR + '\0']) {
        expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(dest) }])).toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
      }
    });
    test('a base58 destination with other padding, or whitespace inside, is not an address', () => {
      const [head, tail] = [ADDR.slice(0, 10), ADDR.slice(10)];
      for (const dest of [ADDR + '\xa0', '\xa0' + ADDR, ADDR + '\x1c', head + ' ' + tail, head + '\n' + tail, '\0' + ADDR, ADDR + 'x', ADDR + '1']) {
        expect(flagsOf([{ scriptpubkey: P2PKH(9) }, payout, { scriptpubkey: depositRecord(dest) }])).toEqual(0n);
      }
    });
    test('a bech32 destination is the whole string, in one case (bech32.cpp)', () => {
      const bech32Payout = { ...payout, scriptpubkey: '0014' + '75'.repeat(20), scriptpubkey_address: BECH32 };
      const flagsFor = (dest: string) => flagsOf([{ scriptpubkey: P2PKH(9) }, bech32Payout, { scriptpubkey: depositRecord(dest) }]);
      expect(flagsFor(BECH32)).toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
      expect(flagsFor(BECH32.toUpperCase())).toEqual(FREEBANK_TX_FLAGS.deposit_from_ecash);
      for (const dest of ['F' + BECH32.slice(1), BECH32.slice(0, -4) + BECH32.slice(-4).toUpperCase(), BECH32 + ' ', ' ' + BECH32, BECH32 + '\n',
        BECH32 + '\0junk', BECH32 + '\0']) {
        expect(flagsFor(dest)).toEqual(0n);
      }
    });
  });

  describe('sameAddress (a destination string against the node\'s spelling of an output address)', () => {
    test('base58: exact, after a NUL cut and C whitespace at the ends; String.trim() would strip more', () => {
      expect(sameAddress(ADDR, ADDR)).toBe(true);
      expect(sameAddress(ADDR, ' \t\n\v\f\r' + ADDR + '\r\f\v\n\t \0\u00a0\ufeff')).toBe(true);
      for (const dest of [ADDR + '\u00a0', '\ufeff' + ADDR, ADDR + '\u2028', '\u3000' + ADDR, ADDR.toLowerCase(), ADDR.toUpperCase(), '\0' + ADDR, '']) {
        expect(sameAddress(ADDR, dest)).toBe(false);
      }
      expect(sameAddress(undefined, ADDR)).toBe(false);
      expect(sameAddress('', '')).toBe(false);
    });
    test('bech32: all lower or all upper case, nothing trimmed, printable ASCII only', () => {
      expect(sameAddress(BECH32, BECH32)).toBe(true);
      expect(sameAddress(BECH32, BECH32.toUpperCase())).toBe(true);
      // the last: in capitals with a KELVIN SIGN, which toLowerCase() turns into 'k' (the node takes bytes 33-126 only)
      for (const dest of ['fbkrT' + BECH32.slice(5), BECH32 + ' ', '\t' + BECH32, BECH32 + '\0', BECH32.toUpperCase().replace('K', '\u212a')]) {
        expect(sameAddress(BECH32, dest)).toBe(false);
      }
    });
  });

  describe('withdrawals to eCash and refund requests (any tx, the coinbase included)', () => {
    const W = '6aacdcf66f57' + '82' + '00'.repeat(60);
    const REFUND = '6afcd2e546' + '33'.repeat(32) + '44'.repeat(65);

    test('a withdrawal', () => {
      expect(getFreebankTxFlags(ordinary([P2PKH(1), W]))).toEqual(FREEBANK_TX_FLAGS.withdrawal_to_ecash);
    });
    test('a refund request', () => {
      expect(REFUND.length).toEqual(204);
      expect(getFreebankTxFlags(ordinary([REFUND, P2PKH(1)]))).toEqual(FREEBANK_TX_FLAGS.withdrawal_refund);
    });
    test('in a coinbase too (the node reads them from every tx)', () => {
      expect(getFreebankTxFlags(coinbase([{ scriptpubkey: P2PKH(9) }, { scriptpubkey: W }, { scriptpubkey: REFUND }])))
        .toEqual(FREEBANK_TX_FLAGS.withdrawal_to_ecash | FREEBANK_TX_FLAGS.withdrawal_refund);
      expect(getFreebankTxFlags(coinbase([{ scriptpubkey: P2PKH(9) }, { scriptpubkey: REFUND }]))).toEqual(FREEBANK_TX_FLAGS.withdrawal_refund);
    });
    test('a refund request only in the node\'s shape: 102 bytes and an id that is not zero (script.cpp)', () => {
      for (const script of ['6afcd2e546abababab', REFUND.slice(0, 202), REFUND + '44', '6afcd2e546' + '00'.repeat(32) + '44'.repeat(65), REFUND.slice(0, 10)]) {
        expect(getFreebankTxFlags(ordinary([script, P2PKH(1)]))).toEqual(0n);
        expect(getFreebankTxFlags(coinbase([{ scriptpubkey: P2PKH(9) }, { scriptpubkey: script }]))).toEqual(0n);
      }
      expect(getFreebankTxFlags(ordinary(['6afcd2e546' + '00'.repeat(31) + '01' + '44'.repeat(65)]))).toEqual(FREEBANK_TX_FLAGS.withdrawal_refund);
    });
    test('the other sidechain objects are not withdrawals', () => {
      expect(getFreebankTxFlags(ordinary([P2PKH(1), '6aacdcf66f50' + '00'.repeat(20), '6aacdcf66f44' + '00'.repeat(20)]))).toEqual(0n);
    });
    test('the classifier adds them, and they do not make the tx non-standard', () => {
      const tx = {
        txid: 'ab'.repeat(32), version: 3, locktime: 0, size: 300, weight: 1200, fee: 1000, status: { confirmed: false },
        vin: [{ is_coinbase: false, prevout: null, scriptsig: '', scriptsig_asm: '', sequence: 0xfffffffd, txid: 'cd'.repeat(32), vout: 0, witness: [] }],
        vout: [
          { value: 50_000, scriptpubkey: P2PKH(1), scriptpubkey_asm: '', scriptpubkey_type: 'p2pkh' },
          { value: 0, scriptpubkey: W, scriptpubkey_asm: '', scriptpubkey_type: 'nonstandard' },
        ],
      } as any;
      const flags = BigInt(Common.getTransactionFlags(tx, 100));
      expect(flags & ALL_FREEBANK_BITS).toEqual(FREEBANK_TX_FLAGS.withdrawal_to_ecash);
      expect(flags & TransactionFlags.nonstandard).toEqual(0n);
    });
  });

  describe('OP_RETURN data', () => {
    test('a coinbase commitment is not data', () => {
      for (const script of [WITNESS_COMMIT, PREV_BLOCK_COMMIT, VERSION_COMMIT, '6aef5d1dfe' + '00'.repeat(32), '6afa86c689' + '00'.repeat(32),
        '6afb5345de' + '00'.repeat(32), depositRecord(ADDR), '6aacdcf66f50' + '00'.repeat(20)]) {
        expect(isCoinbaseCommitment(script)).toBe(true);
        expect(isOpReturnData(coinbase([]), script)).toBe(false);
      }
    });
    test('other OP_RETURN outputs are data, in a coinbase too', () => {
      for (const script of ['6a04deadbeef', '6a', '6a0b' + hex('hello world'), '6aacdcf66f57' + '00'.repeat(20)]) {
        expect(isCoinbaseCommitment(script)).toBe(false);
        expect(isOpReturnData(coinbase([]), script)).toBe(true);
      }
    });
    test('an ordinary tx carrying a witness-commitment look-alike is still data', () => {
      expect(isOpReturnData(ordinary([]), WITNESS_COMMIT)).toBe(true);
    });
    test('the classifier: data in a coinbase or an ordinary tx is flagged, the witness commitment is not', () => {
      const cb = (scripts: string[]) => ({
        txid: 'ef'.repeat(32), version: 3, locktime: 0, size: 200, weight: 800, fee: 0, status: { confirmed: true },
        vin: [{ is_coinbase: true, prevout: null, scriptsig: '5f0101', scriptsig_asm: '', sequence: 0xffffffff, txid: '00'.repeat(32), vout: 0xffffffff, witness: ['00'.repeat(32)] }],
        vout: scripts.map((s) => ({ value: 0, scriptpubkey: s, scriptpubkey_asm: '', scriptpubkey_type: scriptType(s) })),
      } as any);
      expect(BigInt(Common.getTransactionFlags(cb([P2PKH(9), WITNESS_COMMIT]), 15)) & TransactionFlags.op_return).toEqual(0n);
      expect(BigInt(Common.getTransactionFlags(cb([P2PKH(9), '6a04deadbeef', WITNESS_COMMIT]), 15)) & TransactionFlags.op_return).toEqual(TransactionFlags.op_return);
    });
  });

  describe('the bit layout', () => {
    test('one bit each, distinct, at or below bit 52', () => {
      const bits = Object.values(FREEBANK_TX_FLAGS);
      for (const bit of bits) {
        expect(bit & (bit - 1n)).toEqual(0n);
        expect(bit > 0n && bit <= (1n << 52n)).toBe(true);
      }
      expect(new Set(bits).size).toEqual(bits.length);
    });

    test('no overlap with mempool\'s bits (including the frontend-only acceleration bit)', () => {
      let upstream = 1n << 19n; // acceleration, frontend only (filters.utils.ts)
      for (const [key, bit] of Object.entries(TransactionFlags)) {
        if (!FREEBANK_KEYS.includes(key)) {
          upstream |= bit;
        }
      }
      expect(upstream & ALL_FREEBANK_BITS).toEqual(0n);
    });

    test('the backend table carries every FreeBank bit under its key', () => {
      for (const key of FREEBANK_KEYS) {
        expect(TransactionFlags[key]).toEqual(FREEBANK_TX_FLAGS[key]);
      }
    });

    test('flags survive being sent as a JS number', () => {
      let all = ALL_FREEBANK_BITS;
      for (const bit of Object.values(TransactionFlags)) {
        all |= bit;
      }
      expect(BigInt(Number(all))).toEqual(all);
      expect(BigInt(Number(FAMILY_BITS | PEG_BITS))).toEqual(FAMILY_BITS | PEG_BITS);
    });
  });

  // The frontend has its own copy of the flag table and of the classifier. It is not in the
  // backend-only build context, so these skip themselves there.
  describe('parity with the frontend', () => {
    const frontendFile = (p: string) => path.join(FRONTEND, p);
    const haveFrontend = fs.existsSync(frontendFile('shared/filters.utils.ts'));
    const maybe = haveFrontend ? test : test.skip;

    maybe('freebank-tx-flags.ts is byte-identical on both sides', () => {
      const backendCopy = fs.readFileSync(path.join(__dirname, '../../api/freebank/freebank-tx-flags.ts'), 'utf8');
      expect(fs.readFileSync(frontendFile('freebank/freebank-tx-flags.ts'), 'utf8')).toEqual(backendCopy);
    });

    maybe('filters.utils.ts has the same TransactionFlags table', () => {
      const source = fs.readFileSync(frontendFile('shared/filters.utils.ts'), 'utf8');
      const block = source.match(/export const TransactionFlags = \{([\s\S]*?)\n\};/);
      expect(block).not.toBeNull();
      const frontend: { [key: string]: bigint } = {};
      const entry = /^\s*(\w+):\s*(0b[01_]+)n,/gm;
      for (let m = entry.exec(block![1]); m; m = entry.exec(block![1])) {
        frontend[m[1]] = BigInt(m[2].replace(/_/g, ''));
      }
      expect(block![1]).toMatch(/^\s*\.\.\.FREEBANK_TX_FLAGS,/m);
      expect(frontend.acceleration).toEqual(1n << 19n);
      delete frontend.acceleration;
      const backend = Object.fromEntries(Object.entries(TransactionFlags).filter(([key]) => !FREEBANK_KEYS.includes(key)));
      expect(frontend).toEqual(backend);
    });

    maybe('the frontend classifier calls the shared helpers', () => {
      const source = fs.readFileSync(frontendFile('shared/transaction.utils.ts'), 'utf8');
      expect(source).toMatch(/flags \|= getFreebankTxFlags\(tx\);/);
      expect(source).toMatch(/case 'op_return': if \(isOpReturnData\(tx, vout\.scriptpubkey\)\)/);
    });
  });
});
