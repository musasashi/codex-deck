import type { Usage } from '../core/types';

const windows = [
  { minutes: 300, label: '5時間', name: '5時間枠' },
  { minutes: 10_080, label: '週次', name: '週次枠' },
];
const resetFormat = new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export class UsageGauges {
  private readonly gauges;

  constructor(private readonly container: HTMLElement) {
    const showTooltip = (tooltip: HTMLElement) => {
      for (const element of container.querySelectorAll<HTMLElement>('[role=tooltip]')) element.hidden = element !== tooltip;
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
      group.addEventListener('mouseenter', () => showTooltip(tooltip));
      group.addEventListener('mouseleave', () => { if (document.activeElement !== meter) tooltip.hidden = true; });
      meter.addEventListener('focus', () => showTooltip(tooltip));
      meter.addEventListener('blur', () => { if (!group.matches(':hover')) tooltip.hidden = true; });
      container.append(group);
      return { ...window, group, meter, tooltip,
        fill: group.querySelector<SVGCircleElement>('.usage-fill')!, value: group.querySelector<HTMLElement>('.usage-value')!,
        remaining: group.querySelector<HTMLElement>('.usage-remaining')!, reset: group.querySelector<HTMLElement>('.usage-reset')! };
    });
    container.ownerDocument.addEventListener('keydown', event => {
      if (event.key === 'Escape') for (const gauge of this.gauges) gauge.tooltip.hidden = true;
    });
  }

  render(usage?: Usage): void {
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
    }
    this.container.hidden = this.gauges.every(gauge => gauge.group.hidden);
  }
}
