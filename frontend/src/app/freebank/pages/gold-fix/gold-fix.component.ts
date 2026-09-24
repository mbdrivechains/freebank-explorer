import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { Observable, combineLatest, map, shareReplay } from 'rxjs';
import { ApiService } from '@app/services/api.service';
import { StateService } from '@app/services/state.service';
import { WebsocketService } from '@app/services/websocket.service';
import { SeoService } from '@app/services/seo.service';
import { CreditLoad, loadOnEachBlock } from '@app/freebank/credit-load';
import { creditActivityRow } from '@app/freebank/credit-activity-summary';
import { gramsPerEcxFrom, satsToEcx } from '@app/freebank/credit-units';
import {
  formatGoldFixEcxPerGram, formatGoldFixPrice, formatGoldFixSatsPerGram, formatGoldFixStored, isGoldFixValue,
} from '@app/freebank/gold-fix-format';
import {
  FreebankActivityItem, FreebankActivityResponse, FreebankDecodedPayload, FreebankGoldFix, FreebankGoldResponse, FreebankOracleSubmitter,
} from '@interfaces/freebank-credit.interface';

// /gold - the gold fix (GET /gold getgoldfix), its bonded submitters (listoraclesubmitters) and the
// recent oracle txs (GET /activity?family=oracle) with their decoded prices. The price is stored
// as milligrams of gold per 1000 ECX and shown as grams per ECX (freebank/gold-fix-format.ts).
// The fix is consensus-inert in this phase: freebank src/oracle.h "INERT BY DESIGN", and the
// getgoldfix help says nothing in the credit rules reads it.

const ORACLE_ACTIVITY_LIMIT = 30;

interface GoldPriceView {
  price: string;                  // '800 g per ECX'
  stored: string;                 // '800,000,000' (mg of gold per 1000 ECX)
}

interface GoldView {
  load: CreditLoad<FreebankGoldResponse>;
  fix: FreebankGoldFix | null;
  fixAge: number | null;          // blocks since the fix formed
  raw: GoldPriceView | null;
  braked: GoldPriceView | null;
  brakedBelowRaw: boolean;        // the braked view is still catching up after a fall
  satsPerGram: string;            // '125,000 sats' at the raw fix
  ecxPerGram: string;             // '0.00125 ECX'
}

interface OracleActivityRow {
  item: FreebankActivityItem;
  opLabel: string;
  submitter: string;              // '2', '3 (new)', or '' when unknown
  report: string;                 // '790 g per ECX' for a submission, 'Bonded' / 'Bonded again' for a bond
  isSubmission: boolean;
  inCurrentFix: boolean;          // a submission in the block where the current fix formed
}

interface OracleActivityView {
  load: CreditLoad<FreebankActivityResponse>;
  rows: OracleActivityRow[];
  fixHeight: number | null;
}

@Component({
  selector: 'app-gold-fix',
  templateUrl: './gold-fix.component.html',
  styleUrls: ['./gold-fix.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoldFixComponent implements OnInit {
  gold$: Observable<GoldView>;
  oracleActivity$: Observable<OracleActivityView>;
  presentationScale$: Observable<string>;

  readonly skeletonRows = [1, 2, 3, 4];

  constructor(
    private apiService: ApiService,
    private stateService: StateService,
    private websocketService: WebsocketService,
    private seoService: SeoService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('Gold fix');
    this.seoService.setDescription('The FreeBank gold fix: the on-chain gold price and the bonded submitters behind it.');
    this.websocketService.want(['blocks']);

    const goldLoad$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankGold$()).pipe(
      shareReplay({ bufferSize: 1, refCount: true }),
    );

    this.gold$ = goldLoad$.pipe(map((load) => this.goldView(load)));

    this.oracleActivity$ = combineLatest([
      loadOnEachBlock(this.stateService, () => this.apiService.getFreebankActivity$('oracle', ORACLE_ACTIVITY_LIMIT)),
      goldLoad$,
    ]).pipe(
      map(([load, goldLoad]): OracleActivityView => {
        const submitters = goldLoad.data?.submitters || [];
        const fixHeight = goldLoad.data?.fix ? goldLoad.data.fix.fixheight : null;
        return {
          load,
          fixHeight,
          rows: (load.data?.items || []).map((item) => this.oracleRow(item, submitters, fixHeight)),
        };
      }),
    );

    // The node's presentation scale (grams per ECX behind every *_grams field), recovered from
    // the largest ECX amount in /summary that has a grams twin. Only for the note under the fix.
    this.presentationScale$ = loadOnEachBlock(this.stateService, () => this.apiService.getFreebankSummary$()).pipe(
      map((load) => {
        const summary = load.data;
        if (!summary) {
          return '';
        }
        const pairs: [number, number | undefined][] = [
          [satsToEcx(summary.loanbook_face_total), summary.loanbook_face_total_grams],
          [satsToEcx(summary.minted_units_total), summary.minted_grams_total],
        ];
        pairs.sort((a, b) => (b[0] || 0) - (a[0] || 0));
        for (const [ecx, grams] of pairs) {
          const scale = gramsPerEcxFrom(ecx, grams);
          if (scale !== null && scale > 0) {
            return formatGoldFixPrice(Math.round(scale * 1e6));
          }
        }
        return '';
      }),
    );
  }

  trackBySubmitter(index: number, submitter: FreebankOracleSubmitter): number {
    return submitter.id;
  }

  trackByTxid(index: number, row: OracleActivityRow): string {
    return row.item.txid;
  }

  private goldView(load: CreditLoad<FreebankGoldResponse>): GoldView {
    const data = load.data;
    const fix = data?.fix || null;
    const view: GoldView = {
      load,
      fix,
      fixAge: null,
      raw: null,
      braked: null,
      brakedBelowRaw: false,
      satsPerGram: '',
      ecxPerGram: '',
    };
    if (fix) {
      view.fixAge = typeof fix.ageblocks === 'number' ? fix.ageblocks : Math.max(0, data.tip_height - fix.fixheight);
      view.raw = { price: formatGoldFixPrice(fix.raw), stored: formatGoldFixStored(fix.raw) };
      view.braked = { price: formatGoldFixPrice(fix.braked), stored: formatGoldFixStored(fix.braked) };
      view.brakedBelowRaw = isGoldFixValue(fix.raw) && isGoldFixValue(fix.braked) && fix.braked < fix.raw;
      view.satsPerGram = formatGoldFixSatsPerGram(fix.raw);
      view.ecxPerGram = formatGoldFixEcxPerGram(fix.raw);
    }
    return view;
  }

  private oracleRow(item: FreebankActivityItem, submitters: FreebankOracleSubmitter[], fixHeight: number | null): OracleActivityRow {
    const submitterIdByPubkey: { [pubkey: string]: number } = {};
    for (const submitter of submitters) {
      submitterIdByPubkey[submitter.pubkey] = submitter.id;
    }
    const row = creditActivityRow(item, { submitterIdByPubkey });
    const decoded: FreebankDecodedPayload = item.decoded || {};
    const id = typeof decoded.submitter_id === 'number' ? decoded.submitter_id : null;
    const isBond = item.op === 1 || item.op_name === 'bond';
    const isSubmission = item.op === 2 || item.op_name === 'submit';

    let submitter = id !== null && id > 0 ? String(id) : '';
    let report = '';
    if (isSubmission) {
      report = typeof decoded.price_mg === 'number' ? formatGoldFixPrice(decoded.price_mg) : '';
    } else if (isBond) {
      if (id !== null && id > 0) {
        report = 'Bonded again';
      } else {
        const assigned = typeof decoded.pubkey === 'string' ? submitterIdByPubkey[decoded.pubkey] : undefined;
        submitter = typeof assigned === 'number' ? `${assigned} (new)` : 'new';
        report = 'Bonded';
      }
    }
    return {
      item,
      opLabel: row.opLabel,
      submitter,
      report: report || row.summary,
      isSubmission,
      inCurrentFix: isSubmission && fixHeight !== null && item.height === fixHeight,
    };
  }
}
