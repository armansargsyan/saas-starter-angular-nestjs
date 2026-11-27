import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClicksChart,
  type DayCount,
  niceMax,
  roundedTop,
} from './clicks-chart';

@Component({
  imports: [ClicksChart],
  template: `<app-clicks-chart [days]="days()" />`,
})
class Host {
  readonly days = signal<DayCount[]>([
    { date: '2026-06-01', count: 0 },
    { date: '2026-06-02', count: 3 },
    { date: '2026-06-03', count: 7 },
  ]);
}

describe('ClicksChart', () => {
  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el };
  }

  it('draws a bar per non-zero day and a hit target per day', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('[data-testid="bar"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="bar-hit"]')).toHaveLength(3);
  });

  it('describes itself for screen readers', async () => {
    const { el } = await render();
    expect(el.querySelector('svg')?.getAttribute('aria-label')).toContain(
      '3 days, 10 clicks in total',
    );
  });

  it('shows a tooltip on hover and with the arrow keys', async () => {
    const { fixture, el } = await render();
    el.querySelectorAll('[data-testid="bar-hit"]')[2].dispatchEvent(
      new PointerEvent('pointerenter'),
    );
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="tooltip"]')?.textContent).toContain(
      '7 clicks',
    );

    const svg = el.querySelector('svg') as SVGElement;
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="tooltip"]')?.textContent).toContain(
      '3 clicks',
    );

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="tooltip"]')?.textContent).toContain(
      '0 clicks',
    );

    svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(el.querySelector('[data-testid="tooltip"]')).toBeNull();
  });

  it('has a table view with every day', async () => {
    const { el } = await render();
    const rows = el.querySelectorAll('[data-testid="chart-table"] tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows[2].textContent).toContain('7');
  });
});

describe('chart helpers', () => {
  it.each([
    [0, 2],
    [1, 2],
    [3, 10],
    [7, 10],
    [11, 20],
    [99, 100],
    [101, 200],
  ])('niceMax(%i) = %i', (value, expected) => {
    expect(niceMax(value)).toBe(expected);
  });

  it('rounds only the top corners, anchored at the baseline', () => {
    const d = roundedTop(10, 100, 20, 50);
    expect(d.startsWith('M10,100')).toBe(true);
    expect(d).toContain('Q10,50 14,50');
    expect(d.endsWith('V100 Z')).toBe(true);
  });

  it('never rounds more than the bar is tall', () => {
    expect(roundedTop(0, 10, 20, 2)).toContain('Q0,8 2,8');
  });

  it('keeps the tooltip inside very narrow charts', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const chart = fixture.debugElement.children[0]
      .componentInstance as ClicksChart & {
      width: { set(v: number): void };
      active: { set(v: number): void };
    };
    chart.width.set(100);
    chart.active.set(2);
    await fixture.whenStable();
    const tip = (
      fixture.nativeElement as HTMLElement
    ).querySelector<HTMLElement>('[data-testid="tooltip"]');
    expect(parseFloat(tip?.style.left ?? '')).toBe(50);
  });
});
