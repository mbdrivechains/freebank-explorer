import { Component, EventEmitter, Output, HostListener, Input, ChangeDetectorRef, OnChanges, SimpleChanges, OnInit, OnDestroy } from '@angular/core';
import { ActiveFilter, FilterGroups, FilterMode, GradientMode, TransactionFilters, filtersForMode, pickFilter } from '@app/shared/filters.utils';
import { StateService } from '@app/services/state.service';
import { Subscription } from 'rxjs';


@Component({
  selector: 'app-block-filters',
  templateUrl: './block-filters.component.html',
  styleUrls: ['./block-filters.component.scss'],
  standalone: false,
})
export class BlockFiltersComponent implements OnInit, OnChanges, OnDestroy {
  @Input() cssWidth: number = 800;
  @Input() excludeFilters: string[] = [];
  @Output() onFilterChanged: EventEmitter<ActiveFilter | null> = new EventEmitter();

  filterSubscription: Subscription;

  filters = TransactionFilters;
  filterGroups = FilterGroups;
  disabledFilters: { [key: string]: boolean } = {};
  activeFilters: string[] = [];
  filterFlags: { [key: string]: boolean } = {};
  filterMode: FilterMode = 'and';
  gradientMode: GradientMode = 'fee';
  menuOpen: boolean = false;

  constructor(
    private stateService: StateService,
    private cd: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.filterSubscription = this.stateService.activeGoggles$.subscribe((active: ActiveFilter) => {
      this.filterMode = active.mode;
      this.gradientMode = active.gradient;
      for (const key of Object.keys(this.filterFlags)) {
        this.filterFlags[key] = false;
      }
      for (const key of active.filters) {
        this.filterFlags[key] = !this.disabledFilters[key];
      }
      this.activeFilters = [...active.filters.filter(key => !this.disabledFilters[key])];
      this.onFilterChanged.emit({ mode: active.mode, filters: this.activeFilters, gradient: this.gradientMode });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes.cssWidth) {
      this.cd.markForCheck();
    }
    if (changes.excludeFilters) {
      this.disabledFilters = {};
      this.excludeFilters.forEach(filter => {
        this.disabledFilters[filter] = true;
      });
    }
  }

  setFilterMode(mode): void {
    this.filterMode = mode;
    // FreeBank: two credit families never match together, so 'All' keeps the latest one picked
    this.setActiveFilters(filtersForMode(this.activeFilters, this.filterMode));
    this.onFilterChanged.emit({ mode: this.filterMode, filters: this.activeFilters, gradient: this.gradientMode });
    this.stateService.activeGoggles$.next({ mode: this.filterMode, filters: [...this.activeFilters], gradient: this.gradientMode });
  }

  setGradientMode(mode): void {
    this.gradientMode = mode;
    this.onFilterChanged.emit({ mode: this.filterMode, filters: this.activeFilters, gradient: this.gradientMode });
    this.stateService.activeGoggles$.next({ mode: this.filterMode, filters: [...this.activeFilters], gradient: this.gradientMode });
  }

  toggleFilter(key): void {
    this.filterFlags[key] = !this.filterFlags[key];
    if (this.filterFlags[key]) {
      // add new active filter, and remove any other flags in the same toggle group
      // (FreeBank: pickFilter; the credit families rule each other out in 'All' mode only)
      this.setActiveFilters(pickFilter(this.activeFilters, key, this.filterMode));
    } else {
      // remove active filter
      this.activeFilters = this.activeFilters.filter(f => f != key);
    }
    const booleanFlags = this.getBooleanFlags();
    this.onFilterChanged.emit({ mode: this.filterMode, filters: this.activeFilters, gradient: this.gradientMode });
    this.stateService.activeGoggles$.next({ mode: this.filterMode, filters: [...this.activeFilters], gradient: this.gradientMode });
  }

  // FreeBank: the active filters, clearing the flags of those left out
  setActiveFilters(filters: string[]): void {
    this.activeFilters.forEach(f => {
      if (!filters.includes(f)) {
        this.filterFlags[f] = false;
      }
    });
    this.activeFilters = filters;
  }

  getBooleanFlags(): bigint | null {
    let flags = 0n;
    for (const key of Object.keys(this.filterFlags)) {
      if (this.filterFlags[key]) {
        flags |= this.filters[key].flag;
      }
    }
    return flags || null;
  }

  @HostListener('document:click', ['$event'])
  onClick(event): boolean {
    // click away from menu
    if (!event.target.closest('button') && !event.target.closest('label')) {
      this.menuOpen = false;
    }
    return true;
  }

  ngOnDestroy(): void {
    this.filterSubscription.unsubscribe();
  }
}
