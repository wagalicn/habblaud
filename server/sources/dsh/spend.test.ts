import { describe, expect, it } from 'vitest';
import { applyBalanceFile, summarizeLedger } from './spend';

const day = (input: number, cny: number, model = 'deepseek:deepseek-chat') => ({
  input,
  output: 10,
  cacheRead: 100,
  cacheWrite: 0,
  calls: 2,
  cost: cny / 7,
  costCny: cny,
  byProviderModel: { [model]: { input, output: 10, cacheRead: 100, cacheWrite: 0, calls: 2, cost: cny / 7, costCny: cny } },
});

describe('summarizeLedger', () => {
  const ledger = {
    version: 1,
    config: { currency: 'CNY', symbol: '¥' },
    days: { '2026-11-23': day(5, 1.5), '2026-11-20': day(7, 2), '2026-11-10': day(11, 4), '2026-10-31': day(13, 8) },
    balanceRef: { total: 59.7, currency: 'CNY', at: 123 },
  };

  it('soma hoje, os últimos 7 dias e o mês, na moeda do plugin', () => {
    const s = summarizeLedger(ledger, new Date(2026, 10, 23, 15), 999)!;
    expect(s.currency).toBe('CNY');
    expect(s.symbol).toBe('¥');
    expect(s.today).toMatchObject({ input: 5, cost: 1.5, calls: 2 });
    expect(s.week.input).toBe(12);
    expect(s.week.cost).toBeCloseTo(3.5);
    expect(s.month.input).toBe(23);
    expect(s.models).toEqual([{ name: 'deepseek:deepseek-chat', tokens: 115, cost: 1.5 }]);
    expect(s.balance).toEqual({ total: 59.7, currency: 'CNY', at: 123 });
    expect(s.fetchedAt).toBe(999);
  });

  it('dia sem registro fica zerado; formato desconhecido dá undefined', () => {
    const s = summarizeLedger(ledger, new Date(2026, 10, 24, 9), 1)!;
    expect(s.today.calls).toBe(0);
    expect(s.models).toEqual([]);
    expect(summarizeLedger({ nope: true }, new Date(), 1)).toBeUndefined();
  });

  it('o arquivo do dsh-habblaud-uso troca o saldo do livro-caixa pelo atual', () => {
    const s = summarizeLedger(ledger, new Date(2026, 10, 23, 15), 999)!;
    const live = applyBalanceFile(s, { source: 'dsh-cost-meter', status: 'ok', currency: 'CNY', total: 42.5, granted: 1, toppedUp: 41.5, fetchedAt: 77 });
    expect(live.balance).toEqual({ total: 42.5, currency: 'CNY', at: 77, granted: 1, toppedUp: 41.5, live: true });
    expect(applyBalanceFile(s, { source: 'dsh-cost-meter', status: 'error' }).balanceStatus).toBe('error');
    expect(applyBalanceFile(s, { nope: 1 })).toBe(s);
  });

  it('o plugin grava só os números do saldo', async () => {
    // @ts-expect-error módulo JS do plugin do DSH, sem tipos
    const { balanceRecord } = await import('../../../mod/dsh-habblaud-uso/index.js');
    const rec = balanceRecord({ balance: { status: 'ok', currency: 'CNY', totalBalance: 10, grantedBalance: 0, toppedUpBalance: 10, fetchedAt: 5, keyLabel: 'sk-***', message: 'x' } }, 9);
    expect(rec).toEqual({ source: 'dsh-cost-meter', status: 'ok', writtenAt: 9, fetchedAt: 5, currency: 'CNY', total: 10, granted: 0, toppedUp: 10 });
    expect(balanceRecord({ balance: { status: 'error', message: 'boom' } }, 9)).toEqual({ source: 'dsh-cost-meter', status: 'error', writtenAt: 9 });
  });

  it('sem o campo convertido, usa o custo em USD', () => {
    const s = summarizeLedger({ config: { currency: 'EUR', symbol: '€' }, days: { '2026-11-23': { input: 1, cost: 0.5 } } }, new Date(2026, 10, 23), 1)!;
    expect(s.currency).toBe('USD');
    expect(s.today.cost).toBe(0.5);
  });
});
