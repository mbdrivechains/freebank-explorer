import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { API_DOC_GROUPS, API_DOCS_TIP, API_NOT_AVAILABLE, ApiDocEndpoint } from '@app/freebank/pages/api-docs/api-docs-data';
import { GOLD_SHOWN } from '@app/freebank/gold-display';

// The FreeBank explorer's REST API documentation (/docs/api/rest). The endpoints, their descriptions and the example
// answers are in api-docs-data.ts, written by explorer/build/make-api-docs.py from a live explorer, which calls every
// documented endpoint. The examples here point at this explorer's own address.

@Component({
  selector: 'app-freebank-api-docs',
  templateUrl: './api-docs.component.html',
  styleUrls: ['../bills-pools.scss', './api-docs.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: false,
})
export class FreebankApiDocsComponent implements OnInit {
  // FreeBank: while gold is off (gold-display.ts), no gold-only endpoint and the wording without gold
  readonly groups = API_DOC_GROUPS.map((group) => ({
    ...group,
    intro: GOLD_SHOWN && group.intro_gold ? group.intro_gold : group.intro,
    endpoints: group.endpoints
      .filter((endpoint) => GOLD_SHOWN || !endpoint.gold_only)
      .map((endpoint) => ({ ...endpoint, description: GOLD_SHOWN && endpoint.description_gold ? endpoint.description_gold : endpoint.description })),
  }));
  readonly notAvailable = API_NOT_AVAILABLE;
  readonly tip = API_DOCS_TIP;
  base = '';                      // this explorer: 'https://explorer.ecxfreebank.com'
  wsBase = '';                    // 'wss://explorer.ecxfreebank.com'
  pagePath = '';                  // '/docs/api/rest': the page has <base href="/">, so '#x' alone means '/#x'

  constructor(
    private seoService: SeoService,
    private stateService: StateService,
  ) { }

  ngOnInit(): void {
    this.seoService.setTitle('API');
    this.seoService.setDescription('The FreeBank explorer\'s REST API: blocks, transactions, the mempool and fees, '
      + 'the credit layer and blind merged mining.');
    this.base = this.stateService.isBrowser ? window.location.origin : '';
    this.wsBase = this.base.replace(/^http/, 'ws');
    this.pagePath = this.stateService.isBrowser ? window.location.pathname : '';
  }

  curl(endpoint: ApiDocEndpoint): string {
    if (endpoint.method === 'POST') {
      return `curl -sSL -X POST -H "Content-Type: text/plain" --data-binary "<signed transaction hex>" "${this.base}${endpoint.path}"`;
    }
    const url = `"${this.base}${endpoint.example || endpoint.path}"`;
    return endpoint.kind === 'binary' ? `curl -sSL -o out.bin ${url}` : `curl -sSL ${url}`;
  }

  /** The example as a link, for GET endpoints that have one. */
  exampleUrl(endpoint: ApiDocEndpoint): string | null {
    return endpoint.method === 'GET' && endpoint.example ? this.base + endpoint.example : null;
  }

  /** '/api/block/:hash/txids' -> 'get-api-block-hash-txids' */
  anchor(endpoint: ApiDocEndpoint): string {
    return (endpoint.method + endpoint.path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  /** The table of contents: the app's router does not scroll to fragments (anchorScrolling is off), so scroll here. */
  scrollTo(event: MouseEvent, id: string): void {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) {
      return;                     // a new tab or window: let the link do it
    }
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  trackByPath(index: number, endpoint: ApiDocEndpoint): string {
    return endpoint.method + endpoint.path;
  }
}
