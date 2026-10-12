import { asertBits, bitsFromTarget, calcAsert, difficultyFromBits, targetFromBits, AsertAnchor } from '../../api/difficulty-adjustment';

// easynet: the explorer's ASERT figures against a real node. Blocks from the easynet build's regtest with
// -testasertanchor=20 (mocktime: 600 s blocks, then 60 s blocks, then 3000 s blocks), read with getblockheader:
// [height, time, bits, difficulty]. Every block above the anchor must get the node's own bits.
const HEADERS: [number, number, number, number][] = [
  [0, 1296688602, 0x1e1fffff, 0.0001220685080616513],
  [19, 1791751025, 0x1e1fffff, 0.0001220685080616513],
  [20, 1791751625, 0x1e1fffff, 0.0001220685080616513],
  [21, 1791752225, 0x1e1fffff, 0.0001220685080616513],
  [22, 1791752825, 0x1e1fffff, 0.0001220685080616513],
  [23, 1791753425, 0x1e1fffff, 0.0001220685080616513],
  [24, 1791754025, 0x1e1fffff, 0.0001220685080616513],
  [25, 1791754625, 0x1e1fffff, 0.0001220685080616513],
  [26, 1791755225, 0x1e1fffff, 0.0001220685080616513],
  [27, 1791755825, 0x1e1fffff, 0.0001220685080616513],
  [28, 1791756545, 0x1e1fffff, 0.0001220685080616513],
  [29, 1791756605, 0x1e1fffff, 0.0001220685080616513],
  [30, 1791756665, 0x1e1ff24f, 0.0001222728061368512],
  [31, 1791756725, 0x1e1fe09f, 0.0001225378227616522],
  [32, 1791756845, 0x1e1fcf0f, 0.0001228021055845589],
  [33, 1791756905, 0x1e1fbf6f, 0.0001230381927672625],
  [34, 1791756965, 0x1e1faddf, 0.0001233046406843127],
  [35, 1791757085, 0x1e1f9c5f, 0.0001235712907411349],
  [36, 1791757265, 0x1e1f8ccf, 0.0001238093895136683],
  [37, 1791757325, 0x1e1f7f4f, 0.0001240166774698468],
  [38, 1791757385, 0x1e1f6ddf, 0.0001242854539377],
  [39, 1791757445, 0x1e1f5c6f, 0.0001245553979532706],
  [40, 1791757505, 0x1e1f4b1f, 0.0001248245694339948],
  [41, 1791757565, 0x1e1f39cf, 0.000125094906824862],
  [42, 1791763625, 0x1e1f288f, 0.0001253654354140232],
  [43, 1791766625, 0x1e1fd8cf, 0.0001226552456999337],
  [44, 1791769625, 0x1e1fffff, 0.0001220685080616513],
  [45, 1791772625, 0x1e1fffff, 0.0001220685080616513],
  [46, 1791778625, 0x1e1fffff, 0.0001220685080616513],
  [47, 1791781625, 0x1e1fffff, 0.0001220685080616513],
  [48, 1791784625, 0x1e1fffff, 0.0001220685080616513],
  [49, 1791787625, 0x1e1fffff, 0.0001220685080616513],
  [50, 1791790625, 0x1e1fffff, 0.0001220685080616513],
  [51, 1791793625, 0x1e1fffff, 0.0001220685080616513],
  [52, 1791796625, 0x1e1fffff, 0.0001220685080616513],
  [53, 1791799625, 0x1e1fffff, 0.0001220685080616513],
  [54, 1791802625, 0x1e1fffff, 0.0001220685080616513],
  [55, 1791805625, 0x1e1fffff, 0.0001220685080616513],
  [56, 1791808625, 0x1e1fffff, 0.0001220685080616513],
  [57, 1791811625, 0x1e1fffff, 0.0001220685080616513],
  [58, 1791814625, 0x1e1fffff, 0.0001220685080616513],
  [59, 1791817625, 0x1e1fffff, 0.0001220685080616513],
];
const at = (h: number): [number, number, number, number] => HEADERS.find((r) => r[0] === h) as [number, number, number, number];
const HALF_LIFE = 172800;
// the node prints a difficulty with 16 significant digits; ours is the same double, shown with 17
const sameDifficulty = (a: number | undefined, b: number): void => expect(Math.abs((a as number) / b - 1)).toBeLessThan(1e-14);
const anchor: AsertAnchor = { height: 20, hash: '', bits: at(20)[2], parentTime: at(19)[1], powLimitBits: at(0)[2] };

describe('easynet ASERT', () => {
  test('compact bits and difficulty as Core computes them', () => {
    for (const [, , bits, difficulty] of HEADERS) {
      expect(bitsFromTarget(targetFromBits(bits))).toEqual(bits);
      sameDifficulty(difficultyFromBits(bits), difficulty);
    }
    expect(bitsFromTarget(targetFromBits(0x1e00ffff))).toEqual(0x1e00ffff); // easynet's proof-of-work limit
  });

  test('every block above the anchor gets the node\'s bits', () => {
    const above = HEADERS.filter(([h]) => h > anchor.height);
    expect(above.length).toBeGreaterThan(30);
    for (const [h, , bits] of above) {
      expect([h, asertBits(anchor, h, at(h - 1)[1], HALF_LIFE).toString(16)]).toEqual([h, bits.toString(16)]);
    }
  });

  test('the proof-of-work limit, not a harder genesis, stops ASERT', () => {
    // a chain whose genesis (and anchor) sits at difficulty 0.28, well above easynet's limit 0x1e00ffff (~0.0039)
    const bits028 = bitsFromTarget((targetFromBits(0x1d00ffff) * 100n) / 28n);
    const hard: AsertAnchor = { height: 2016, hash: '', bits: bits028, parentTime: 1_800_000_000, powLimitBits: 0x1e00ffff };
    const late = (halfLives: number) => hard.parentTime + 600 * 2 + HALF_LIFE * halfLives; // block 2018's parent time
    sameDifficulty(difficultyFromBits(asertBits(hard, 2018, late(0), HALF_LIFE)), difficultyFromBits(bits028));
    // two half-lives late: a quarter of 0.28, below the genesis difficulty
    const quarter = difficultyFromBits(asertBits(hard, 2018, late(2), HALF_LIFE));
    expect(quarter).toBeLessThan(0.0701);
    expect(quarter).toBeGreaterThan(0.0699);
    // ten half-lives late: past the limit, so exactly the limit
    expect(asertBits(hard, 2018, late(10), HALF_LIFE)).toEqual(0x1e00ffff);
  });

  test('calcAsert: the next block from the tip, the change, the schedule and the average block time', () => {
    const recent = HEADERS.filter(([h]) => h >= 33 && h <= 41).map(([height, timestamp]) => ({ height, timestamp }));
    const a = calcAsert(anchor, HALF_LIFE, recent);
    expect(a?.nextBits).toEqual(at(42)[2]);
    sameDifficulty(a?.nextDifficulty, at(42)[3]);
    sameDifficulty(a?.tipDifficulty, at(41)[3]);
    expect(a?.nextChange).toBeCloseTo((at(42)[3] / at(41)[3] - 1) * 100, 10);
    expect(a?.scheduleOffset).toEqual(at(41)[1] - at(19)[1] - 600 * (41 - 20 + 1));
    expect(a?.scheduleOffset).toBeLessThan(0); // 60-second blocks: ahead of schedule, so the difficulty rose
    expect(a?.timeAvgBlocks).toEqual(8);
    expect(a?.timeAvg).toEqual(Math.round((at(41)[1] - at(33)[1]) / 8 * 1000));
    expect(calcAsert(anchor, HALF_LIFE, [{ height: 20, timestamp: at(20)[1] }])).toBeNull(); // not above the anchor
  });
});
