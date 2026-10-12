import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { BehaviorSubject, Subscription, combineLatest, interval, of } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, map, switchMap } from 'rxjs/operators';
import { EChartsOption } from '@app/graphs/echarts';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { difficultyFromBits, formatDifficulty, formatDuration, formatHashrate } from '@app/shared/asert.utils';
import { AsertBlock, AsertInfo, AsertSeries, DifficultyAdjustment } from '@interfaces/node-api.interface';

// easynet: the ASERT page, on top of the mining dashboard. easynet is for trying ASERT live (Michael, 2026-10-12: "we
// will be throwing different hashrates etc to try at the asert function"): every block's difficulty against what ASERT
// asked, block times against the 10-minute target, the hashrate the blocks imply, and how far the chain is ahead of or
// behind its schedule since the anchor (which is what sets the difficulty). Figures for the next block come exact from
// the backend (difficulty-adjustment.ts); the series from GET /api/v1/mining/asert.

const SPANS = [144, 432, 1008, 2016];
const WINDOWS = [6, 36, 144];
const TWENTY_MINUTES = 1200;
const COLORS = {
  difficulty: '#D81B60', target: '#ffffff', minDifficulty: '#ff9f00', interval: '#4a68b9', intervalAvg: '#1bd8f4',
  hashrate: ['#FDD835', '#FFB300', '#FB8C00'], offset: '#1bd8f4',
};

interface Row extends AsertBlock {
  change: number | null;     // percent vs the previous block's difficulty
  matches: boolean | null;   // bits equal ASERT's (null below the anchor)
}

interface Stats {
  tipHeight: number;
  tipTime: number;
  anchorHeight: number;
  asertActive: boolean;
  blocksToAsert: number;
  hashrates: { window: number, value: number | null }[];
  avgTimes: { window: number, value: number | null }[];
  scheduleOffset: number | null;
  minDiffCount: number;
  span: number;
}

@Component({
  selector: 'app-asert-lab',
  templateUrl: './asert-lab.component.html',
  styleUrls: ['./asert-lab.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AsertLabComponent implements OnInit, OnDestroy {
  spans = SPANS;
  span$ = new BehaviorSubject<number>(432);
  isLoading = true;
  error = false;
  stats: Stats | null = null;
  asert: AsertInfo | null = null;
  da: DifficultyAdjustment | null = null;
  rows: Row[] = [];
  chartOptions: EChartsOption = {};
  chartInitOptions = { renderer: 'svg' };
  now = Date.now() / 1000;
  halfLife = 172800;
  lastDifficulty: number | null = null;
  formatDifficulty = formatDifficulty;
  formatHashrate = formatHashrate;
  formatDuration = formatDuration;
  private subs: Subscription[] = [];

  constructor(
    private apiService: ApiService,
    public stateService: StateService,
    private cd: ChangeDetectorRef,
  ) { }

  ngOnInit(): void {
    const tip$ = this.stateService.blocks$.pipe(
      map((blocks) => blocks?.[0]?.height ?? -1),
      distinctUntilChanged(),
      debounceTime(500),
    );
    this.subs.push(combineLatest([tip$, this.span$]).pipe(
      switchMap(([, span]) => this.apiService.getAsert$(span).pipe(
        map((data) => ({ data, span })),
        catchError(() => of(null)),
      )),
    ).subscribe((res) => {
      this.isLoading = false;
      this.error = !res;
      if (res) {
        this.update(res.data, res.span);
      }
      this.cd.markForCheck();
    }));
    this.subs.push(this.stateService.difficultyAdjustment$.subscribe((da) => {
      this.da = da;
      this.asert = da?.asert || null;
      this.cd.markForCheck();
    }));
    // the 20-minute rule countdown
    this.subs.push(interval(1000).subscribe(() => {
      this.now = Date.now() / 1000;
      this.cd.markForCheck();
    }));
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
  }

  setSpan(span: number): void {
    this.isLoading = true;
    this.span$.next(span);
  }

  /** The hashrate that gives 10-minute blocks at the next block's difficulty (difficulty x 2^32 / 600). */
  holdRate(): number | null {
    const d = this.asert?.nextDifficulty ?? this.lastDifficulty;
    return d ? d * 4294967296 / 600 : null;
  }

  /** Seconds until a block may be mined at the minimum difficulty (20 minutes after the tip's timestamp); <= 0: now. */
  minDifficultyIn(): number | null {
    return this.stats ? this.stats.tipTime + TWENTY_MINUTES - this.now : null;
  }

  private update(data: AsertSeries, span: number): void {
    this.halfLife = data.halfLife;
    const all = data.blocks;
    const work = all.map((b) => b.difficulty * 4294967296);
    // hashrate over the last k blocks ending at index i: their work over the time since the block k before
    const hashrateAt = (i: number, k: number): number | null => {
      if (i - k < 0) {
        return null;
      }
      const dt = all[i].time - all[i - k].time;
      if (dt <= 0) {
        return null;
      }
      let w = 0;
      for (let j = i - k + 1; j <= i; j++) {
        w += work[j];
      }
      return w / dt;
    };
    const avgTimeAt = (i: number, k: number): number | null => i - k >= 0 ? (all[i].time - all[i - k].time) / k : null;
    const first = Math.max(0, all.length - span);
    const visible = all.slice(first);
    const last = all.length - 1;
    const tip = all[last];
    const asertActive = !!data.anchor && !!tip && tip.height > data.anchorHeight;
    this.lastDifficulty = tip ? tip.difficulty : null;

    this.stats = tip ? {
      tipHeight: tip.height,
      tipTime: tip.time,
      anchorHeight: data.anchorHeight,
      asertActive,
      blocksToAsert: Math.max(0, data.anchorHeight + 1 - tip.height),
      hashrates: WINDOWS.map((k) => ({ window: k, value: hashrateAt(last, k) })),
      avgTimes: WINDOWS.map((k) => ({ window: k, value: avgTimeAt(last, k) })),
      scheduleOffset: tip.scheduleOffset,
      minDiffCount: visible.filter((b) => b.minDifficulty).length,
      span: visible.length,
    } : null;

    this.rows = visible.map((b, n) => {
      const i = first + n;
      const prev = i > 0 ? all[i - 1] : null;
      return {
        ...b,
        change: prev && prev.height === b.height - 1 ? (b.difficulty / prev.difficulty - 1) * 100 : null,
        matches: b.expectedBits === null ? null : b.bits === b.expectedBits,
      };
    }).reverse().slice(0, 20);

    const heights = visible.map((b) => String(b.height));
    const idx = visible.map((_, n) => first + n);
    const anchorMark = data.anchorHeight > 0 && visible.length && data.anchorHeight >= visible[0].height && data.anchorHeight <= visible[visible.length - 1].height
      ? { silent: true, symbol: 'none', lineStyle: { color: '#888', type: 'dashed' as const }, label: { formatter: 'ASERT from here', color: '#aaa' }, data: [{ xAxis: String(data.anchorHeight) }] }
      : undefined;
    const grid = (top: number) => ({ left: 70, right: 24, top, height: 120 });
    const xAxis = (gridIndex: number, show: boolean) => ({
      type: 'category' as const, gridIndex, data: heights, boundaryGap: false,
      axisLabel: { show, color: 'rgb(110, 112, 121)' }, axisTick: { show }, axisLine: { show: true, lineStyle: { color: '#3a3d4f' } },
    });
    const yAxis = (gridIndex: number, name: string, formatter: (v: number) => string, extra: object = {}) => ({
      type: 'value' as const, gridIndex, name, nameTextStyle: { color: '#aaa', align: 'left' as const }, scale: true,
      axisLabel: { color: 'rgb(110, 112, 121)', formatter }, splitLine: { lineStyle: { type: 'dotted' as const, color: '#ffffff66', opacity: 0.25 } },
      ...extra,
    });
    this.chartOptions = {
      animation: false,
      color: [COLORS.difficulty],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(17, 19, 31, 1)',
        borderRadius: 4,
        textStyle: { color: '#b1b1b1', align: 'left' },
        borderColor: '#000',
        formatter: (params: any) => {
          const n = params?.[0]?.dataIndex;
          if (n === undefined) {
            return '';
          }
          const b = visible[n];
          const i = idx[n];
          const lines = [
            `<b>Block ${b.height}</b>`,
            `Difficulty ${formatDifficulty(b.difficulty)}` + (b.minDifficulty ? ' <span style="color:#ff9f00">(minimum: 20-minute rule)</span>' : ''),
            b.expectedBits !== null ? `ASERT asked ${formatDifficulty(difficultyFromBits(b.expectedBits))}` : 'Before ASERT (2016-block rule)',
            `Block time ${b.interval === null ? '–' : formatDuration(b.interval)}`,
            `Hashrate (6 / 36 / 144) ${WINDOWS.map((k) => formatHashrate(hashrateAt(i, k))).join(' / ')}`,
          ];
          if (b.scheduleOffset !== null) {
            lines.push(`${b.scheduleOffset > 0 ? 'Behind' : 'Ahead of'} schedule by ${formatDuration(b.scheduleOffset)}`);
          }
          return lines.join('<br>');
        },
      },
      grid: [grid(80), grid(250), grid(420), grid(590)],
      xAxis: [xAxis(0, false), xAxis(1, false), xAxis(2, false), xAxis(3, true)],
      yAxis: [
        yAxis(0, 'Difficulty', (v) => formatDifficulty(v)),
        yAxis(1, 'Block time', (v) => formatDuration(v), { scale: false, min: 0 }),
        yAxis(2, 'Hashrate', (v) => formatHashrate(v)),
        yAxis(3, 'Schedule (+ behind / - ahead)', (v) => (v < 0 ? '-' : '') + formatDuration(v)),
      ],
      legend: {
        type: 'scroll', // one line, with arrows on a narrow screen
        pageTextStyle: { color: '#b1b1b1' },
        pageIconColor: '#b1b1b1',
        top: 0,
        left: 70,
        right: 24,
        itemGap: 14,
        textStyle: { color: '#b1b1b1' },
        data: ['Difficulty', 'ASERT target', 'Minimum-difficulty block', 'Block time', `Average of ${WINDOWS[1]}`,
          ...WINDOWS.map((k) => `Hashrate (${k} blocks)`), 'Schedule'],
      },
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: 0, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2, 3], bottom: 8, height: 20, showDetail: false },
      ],
      series: [
        { name: 'Difficulty', type: 'line', step: 'middle', xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', color: COLORS.difficulty,
          data: visible.map((b) => b.difficulty), markLine: anchorMark },
        { name: 'ASERT target', type: 'line', step: 'middle', xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', color: COLORS.target,
          lineStyle: { type: 'dashed', width: 1, opacity: 0.7 },
          data: visible.map((b) => b.expectedBits === null ? null : difficultyFromBits(b.expectedBits)) },
        { name: 'Minimum-difficulty block', type: 'scatter', xAxisIndex: 0, yAxisIndex: 0, symbolSize: 7, color: COLORS.minDifficulty,
          data: visible.map((b) => b.minDifficulty ? b.difficulty : null) },
        { name: 'Block time', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, color: COLORS.interval, barMaxWidth: 6,
          data: visible.map((b) => b.interval === null ? null : Math.max(0, b.interval)),
          markLine: { silent: true, symbol: 'none', lineStyle: { color: '#fff', type: 'dashed' }, label: { formatter: '10 min', color: '#aaa', position: 'insideEndTop' }, data: [{ yAxis: 600 }] } },
        { name: `Average of ${WINDOWS[1]}`, type: 'line', xAxisIndex: 1, yAxisIndex: 1, symbol: 'none', color: COLORS.intervalAvg,
          data: idx.map((i) => avgTimeAt(i, WINDOWS[1])) },
        ...WINDOWS.map((k, w) => ({
          name: `Hashrate (${k} blocks)`, type: 'line' as const, xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', color: COLORS.hashrate[w],
          lineStyle: { width: w === 0 ? 1 : 2 }, data: idx.map((i) => hashrateAt(i, k)),
        })),
        { name: 'Schedule', type: 'line', xAxisIndex: 3, yAxisIndex: 3, symbol: 'none', color: COLORS.offset, areaStyle: { opacity: 0.15 },
          data: visible.map((b) => b.scheduleOffset),
          markLine: { silent: true, symbol: 'none', lineStyle: { color: '#888' }, label: { show: false }, data: [{ yAxis: 0 }] } },
      ],
    } as EChartsOption;
  }
}
