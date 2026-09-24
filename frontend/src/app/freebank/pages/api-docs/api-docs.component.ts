import { ChangeDetectionStrategy, Component, OnInit } from '@angular/core';
import { SeoService } from '@app/services/seo.service';
import { StateService } from '@app/services/state.service';
import { API_DOC_GROUPS, API_DOCS_TIP, API_NOT_AVAILABLE, ApiDocEndpoint } from '@app/freebank/pages/api-docs/api-docs-data';

// The FreeBank explorer's REST API documentation (/docs/api/rest). The endpoints, their descriptions and the example
// answers are in api-docs-data.ts, written by explorer/build/make-api-docs.py from a live explorer, which calls every
// documented endpoint. The examples here point at this explorer's own address.

@Component({
  selector: 'app-freebank-api-docs',
  templateUrl: './api-docs.component.html',
  styleUrls: ['../bills-pools.scss', './api-docs.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FreebankApiDocsComponent implements OnInit {
  readonly groups = API_DOC_GROUPS;
  readonly notAvailable = API_NOT_AVAILABLE;
  readonly tip = API_DOCS_TIP;
  base = '';                      // this explorer: 'https://explorer.ecxfreebank.com'
  wsBase = '';                    // 'wss://explorer.ecxfreebank.com'

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
  }

  curl(endpoint: ApiDocEndpoint): string {
    if (endpoint.method === 'POST') {
      return `curl -sSL -X POST "${this.base}${endpoint.path}" -d "<signed transaction hex>"`;
    }
    return `curl -sSL "${this.base}${endpoint.example || endpoint.path}"`;
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
  scrollTo(event: Event, id: string): void {
    event.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  trackByPath(index: number, endpoint: ApiDocEndpoint): string {
    return endpoint.method + endpoint.path;
  }
}
