import { Injectable } from '@angular/core';
import { Title, Meta } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map, switchMap } from 'rxjs';
import { StateService } from '@app/services/state.service';

@Injectable({
  providedIn: 'root'
})
export class SeoService {
  network = '';
  baseTitle = 'FreeBank Explorer';
  baseDescription = 'Explore the FreeBank sidechain: see its blocks, transactions and mempool in real time.';
  // FreeBank: canonical URLs use the host the explorer is served from, never a hardcoded domain
  baseDomain = window.location.host;

  canonicalLink: HTMLLinkElement | null = document.getElementById('canonical') as HTMLLinkElement;

  constructor(
    private titleService: Title,
    private metaService: Meta,
    private stateService: StateService,
    private router: Router,
    private activatedRoute: ActivatedRoute,
  ) {
    // save original meta tags
    this.baseDescription = this.rebrand(metaService.getTag('name=\'description\'')?.content || this.baseDescription);
    this.baseTitle = titleService.getTitle()?.split(' - ')?.[0] || this.baseTitle;

    this.stateService.networkChanged$.subscribe((network) => this.network = network);
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd),
      map(() => this.activatedRoute),
      map(route => {
        while (route.firstChild) {route = route.firstChild;}
        return route;
      }),
      filter(route => route.outlet === 'primary'),
      switchMap(route => route.data),
    ).subscribe((data) => {
      this.clearSoft404();
    });
  }

  setTitle(newTitle: string): void {
    this.titleService.setTitle(newTitle + ' - ' + this.getTitle());
    this.metaService.updateTag({ property: 'og:title', content: newTitle});
    this.metaService.updateTag({ name: 'twitter:title', content: newTitle});
    this.metaService.updateTag({ property: 'og:meta:ready', content: 'ready'});
  }

  resetTitle(): void {
    this.titleService.setTitle(this.getTitle());
    this.metaService.updateTag({ property: 'og:title', content: this.getTitle()});
    this.metaService.updateTag({ name: 'twitter:title', content: this.getTitle()});
    this.metaService.updateTag({ property: 'og:meta:ready', content: 'ready'});
  }

  setEnterpriseTitle(title: string, override: boolean = false) {
    if (override) {
      this.baseTitle = title;
    } else {
      this.baseTitle = title + ' - ' + this.baseTitle;
    }
    this.resetTitle();
  }

  setDescription(newDescription: string): void {
    newDescription = this.rebrand(newDescription);
    this.metaService.updateTag({ name: 'description', content: newDescription});
    this.metaService.updateTag({ name: 'twitter:description', content: newDescription});
    this.metaService.updateTag({ property: 'og:description', content: newDescription});
  }

  resetDescription(): void {
    this.metaService.updateTag({ name: 'description', content: this.getDescription()});
    this.metaService.updateTag({ name: 'twitter:description', content: this.getDescription()});
    this.metaService.updateTag({ property: 'og:description', content: this.getDescription()});
  }

  updateCanonical(path) {
    if (!this.canonicalLink) {
      // index.html ships no static canonical (it would point every page at one URL), so create it here
      this.canonicalLink = document.createElement('link');
      this.canonicalLink.id = 'canonical';
      this.canonicalLink.rel = 'canonical';
      document.head.appendChild(this.canonicalLink);
    }
    this.canonicalLink.setAttribute('href', window.location.protocol + '//' + this.baseDomain + path);
  }

  getTitle(): string {
    // FreeBank: one site, one network; no ' - Bitcoin Explorer' / network suffix
    return this.baseTitle;
  }

  getDescription(): string {
    return this.baseDescription;
  }

  // FreeBank: page descriptions are upstream strings written for Bitcoin/mempool.space;
  // rewrite the names in one place instead of editing every $localize string
  rebrand(text: string): string {
    return (text || '')
      .replace(/The Mempool Open Source Project(®|&reg;)?/g, 'FreeBank Explorer')
      .replace(/mempool\.space/g, 'FreeBank Explorer')
      .replace(/\bMempool's\b/g, 'FreeBank Explorer\'s')
      .replace(/\bBitcoin\b(?! Core)/g, 'FreeBank')
      .replace(/\bBTC\b/g, 'ECX')
      .replace(/ (?:and|in) USD\b/g, ''); // no fiat
  }

  clearSoft404() {
    window['soft404'] = false;
  }

  logSoft404() {
    window['soft404'] = true;
  }
}
