import { Input, ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { StateService } from '@app/services/state.service';
import { EnterpriseService } from '@app/services/enterprise.service';
import { FREEBANK_APP_URL } from '@app/freebank/app-link';

@Component({
  selector: 'app-global-footer',
  templateUrl: './global-footer.component.html',
  styleUrls: ['./global-footer.component.scss'],
  standalone: false,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GlobalFooterComponent implements OnInit, OnDestroy {
  @Input() user: any = undefined; // still bound by master-page; unused (no sign-in on FreeBank Explorer)

  frontendGitCommitHash = this.stateService.env.GIT_COMMIT_HASH;
  packetJsonVersion = this.stateService.env.PACKAGE_JSON_VERSION;
  freebankVersion = this.stateService.env.FREEBANK_VERSION || '';
  freebankAppUrl = FREEBANK_APP_URL; // FreeBank: the desktop app's latest release
  sourceUrl = this.stateService.env.SOURCE_URL || '';
  isServicesPage = false;

  enterpriseInfo: any;
  enterpriseInfo$: Subscription;

  constructor(
    public stateService: StateService,
    private enterpriseService: EnterpriseService,
    private cd: ChangeDetectorRef,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.isServicesPage = this.router.url.includes('/services/');

    this.enterpriseInfo$ = this.enterpriseService.info$.subscribe(info => {
      this.enterpriseInfo = info;
      this.cd.markForCheck();
    });
  }

  ngOnDestroy(): void {
    if (this.enterpriseInfo$) {
      this.enterpriseInfo$.unsubscribe();
    }
  }
}
