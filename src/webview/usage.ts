import type { JsonObject, ResetCredits, Usage } from '../core/types';
import { availableResetCredits, resetCreditExpiry } from '../core/usage';

const windows = [
  { minutes: 300, label: '5時間', name: '5時間枠' },
  { minutes: 10_080, label: '週次', name: '週次枠' },
];
const resetFormat = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export class UsageGauges {
  private readonly gauges;
  private summary?: ResetCredits;
  private creditSignature = '';
  private pendingRequest?: string;

  constructor(private readonly container: HTMLElement, private readonly post: (type: string, data: Record<string, unknown>) => void) {
    const showTooltip = (tooltip: HTMLElement) => {
      this.renderCredits();
      for (const element of container.querySelectorAll<HTMLElement>('.usage-tooltip')) element.hidden = element !== tooltip;
      this.positionTooltip(tooltip);
    };
    this.gauges = windows.map(window => {
      const group = document.createElement('div');
      group.className = 'usage-gauge';
      group.hidden = true;
      const tooltipId = `usage-tooltip-${window.minutes}`;
      group.innerHTML = `<div class="usage-meter" role="meter" tabindex="0" aria-label="Codex ${window.name}の残量" aria-valuemin="0" aria-valuemax="100" aria-describedby="${tooltipId}">
        <svg class="usage-ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="usage-track" cx="18" cy="18" r="15.5"/><circle class="usage-fill" cx="18" cy="18" r="15.5" pathLength="100" transform="rotate(-90 18 18)"/></svg>
        <span class="usage-value" aria-hidden="true"></span><span class="usage-label" aria-hidden="true">${window.label}</span>
      </div><div id="${tooltipId}" class="usage-tooltip" role="tooltip" hidden><strong>Codex · ${window.name}</strong><span class="usage-remaining"></span><span class="usage-reset"></span></div>`;
      const meter = group.querySelector<HTMLElement>('.usage-meter')!;
      const tooltip = group.querySelector<HTMLElement>('.usage-tooltip')!;
      if (window.minutes === 10_080) {
        tooltip.insertAdjacentHTML('beforeend', '<section class="usage-tickets" aria-label="リセットチケット" hidden><strong class="usage-ticket-count"></strong><div class="usage-ticket-list"></div><span class="usage-ticket-note"></span></section><span class="usage-ticket-result" role="status" hidden></span>');
      }
      group.addEventListener('mouseenter', () => showTooltip(tooltip));
      group.addEventListener('mouseleave', () => { if (!group.contains(document.activeElement)) tooltip.hidden = true; });
      group.addEventListener('focusin', () => showTooltip(tooltip));
      group.addEventListener('focusout', event => { if (!group.contains(event.relatedTarget as Node | null) && !group.matches(':hover')) tooltip.hidden = true; });
      container.append(group);
      return { ...window, group, meter, tooltip,
        fill: group.querySelector<SVGCircleElement>('.usage-fill')!, value: group.querySelector<HTMLElement>('.usage-value')!,
        remaining: group.querySelector<HTMLElement>('.usage-remaining')!, reset: group.querySelector<HTMLElement>('.usage-reset')! };
    });
    container.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-reset-credit]');
      if (!button || this.pendingRequest || button.disabled) return;
      const credit = availableResetCredits(this.summary).find(credit => credit.id === button.dataset.resetCredit);
      if (!credit) { this.renderCredits(); return; }
      this.pendingRequest = crypto.randomUUID();
      this.showResult('使用するか確認しています…');
      this.updateButtons();
      this.post('requestResetCredit', { creditId: credit.id, requestId: this.pendingRequest });
    });
    container.ownerDocument.addEventListener('keydown', event => {
      if (event.key === 'Escape') for (const gauge of this.gauges) {
        if (gauge.tooltip.contains(document.activeElement)) gauge.meter.focus();
        gauge.tooltip.hidden = true;
      }
    });
    container.ownerDocument.defaultView?.addEventListener('resize', () => {
      for (const gauge of this.gauges) if (!gauge.tooltip.hidden) this.positionTooltip(gauge.tooltip);
    });
  }

  render(usage?: Usage): void {
    this.summary = usage?.resetCredits;
    this.renderCredits();
    if (!usage) this.showResult('');
    const bucket = usage?.buckets.find(bucket => bucket.id === 'codex') ?? usage?.buckets.find(bucket => bucket.id === 'default');
    for (const gauge of this.gauges) {
      const window = bucket?.windows.find(window => window.windowDurationMins === gauge.minutes && Number.isFinite(window.usedPercent) && window.usedPercent >= 0);
      gauge.group.hidden = !window;
      if (!window) { gauge.tooltip.hidden = true; continue; }
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      const percent = `${Number(remaining.toFixed(1))}%`;
      gauge.meter.setAttribute('aria-valuenow', String(remaining));
      gauge.meter.setAttribute('aria-valuetext', `残り${percent}`);
      gauge.group.dataset.level = remaining <= 5 ? 'critical' : remaining <= 20 ? 'low' : 'normal';
      gauge.fill.setAttribute('stroke-dasharray', `${remaining} 100`);
      gauge.value.textContent = percent;
      gauge.remaining.textContent = `残り ${percent}`;
      const reset = window.resetsAt === undefined ? undefined : new Date(window.resetsAt);
      gauge.reset.hidden = !reset || !Number.isFinite(reset.getTime());
      gauge.reset.textContent = gauge.reset.hidden ? '' : `リセット予定: ${resetFormat.format(reset)}`;
      if (!gauge.tooltip.hidden) this.positionTooltip(gauge.tooltip);
    }
    this.container.hidden = this.gauges.every(gauge => gauge.group.hidden);
  }

  handleMessage(message: JsonObject): void {
    if (message.type !== 'resetCreditResult' || !this.pendingRequest || message.requestId !== this.pendingRequest) return;
    this.pendingRequest = undefined;
    this.showResult(typeof message.error === 'string' ? message.error : typeof message.message === 'string' ? message.message : '', typeof message.error === 'string');
    this.updateButtons();
  }

  private renderCredits(): void {
    const gauge = this.gauges?.find(gauge => gauge.minutes === 10_080);
    if (!gauge) return;
    const section = gauge.tooltip.querySelector<HTMLElement>('.usage-tickets')!;
    section.hidden = !this.summary;
    gauge.tooltip.classList.toggle('has-tickets', !!this.summary);
    gauge.tooltip.setAttribute('role', this.summary ? 'dialog' : 'tooltip');
    if (this.summary) {
      gauge.tooltip.setAttribute('aria-label', 'Codex 週次枠');
      gauge.meter.setAttribute('aria-haspopup', 'dialog');
    } else {
      gauge.tooltip.removeAttribute('aria-label');
      gauge.meter.removeAttribute('aria-haspopup');
    }
    const credits = availableResetCredits(this.summary);
    const expired = this.summary?.credits?.filter(credit => credit.expiresAt !== null && credit.expiresAt <= Date.now()).length ?? 0;
    const count = Math.max(0, (this.summary?.availableCount ?? 0) - expired);
    const signature = JSON.stringify([this.summary !== undefined, count, credits]);
    if (signature === this.creditSignature) return;
    this.creditSignature = signature;
    section.querySelector('.usage-ticket-count')!.textContent = this.summary ? `リセットチケット · 残り${count}枚` : '';
    const list = section.querySelector('.usage-ticket-list')!;
    const focusedId = (document.activeElement as HTMLElement | null)?.dataset.resetCredit;
    list.replaceChildren(...credits.map(credit => {
      const row = document.createElement('div'); row.className = 'usage-ticket';
      const details = document.createElement('div'); details.className = 'usage-ticket-details';
      const title = document.createElement('span'); title.textContent = credit.title ?? 'Codex リセットチケット';
      const expiry = document.createElement('span'); expiry.className = 'usage-ticket-expiry'; expiry.textContent = resetCreditExpiry(credit.expiresAt);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
      button.dataset.resetCredit = credit.id; button.textContent = '使用';
      button.setAttribute('aria-label', `${credit.title ?? 'リセットチケット'}を使用`);
      details.append(title, expiry); row.append(details, button); return row;
    }));
    const note = section.querySelector<HTMLElement>('.usage-ticket-note')!;
    note.textContent = !this.summary ? '' : count === 0 ? '使用可能なチケットはありません。' : count > credits.length ? '一部のチケットの詳細を取得できません。' : '';
    note.hidden = !note.textContent;
    this.updateButtons();
    if (focusedId) {
      const button = [...list.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.resetCredit === focusedId && !button.disabled);
      (button ?? gauge.meter).focus();
    }
  }

  private updateButtons(): void {
    for (const button of this.container.querySelectorAll<HTMLButtonElement>('[data-reset-credit]')) button.disabled = !!this.pendingRequest;
  }

  private positionTooltip(tooltip: HTMLElement): void {
    tooltip.style.left = '0px';
    const box = tooltip.getBoundingClientRect();
    const width = this.container.ownerDocument.documentElement.clientWidth;
    tooltip.style.left = `${Math.max(12 - box.left, Math.min(0, width - 12 - box.right))}px`;
  }

  private showResult(text: string, error = false): void {
    const status = this.container.querySelector<HTMLElement>('.usage-ticket-result');
    if (!status) return;
    status.textContent = text; status.hidden = !text;
    status.classList.toggle('error-notice', error);
  }
}
