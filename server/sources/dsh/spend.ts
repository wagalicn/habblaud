// Gasto local do DeepSeek Harness: o plugin dsh-cost-meter mantém um livro-caixa em
// <~/.dsh>/storages/cost-meter/ledger.json (dias -> tokens, chamadas e custo por provedor:modelo, e o último saldo
// consultado). Aqui ele só é lido — nunca escrito — e vira o AccountSpend da conta do DeepSeek Harness (hoje, últimos
// 7 dias, mês corrente, modelos de hoje). O custo é o que o plugin estimou com a tabela de preços dele, na moeda
// escolhida nele (campo `cost<Moeda>`, ex.: costCny; sem ele, `cost` em USD). Modelo sem preço conta 0.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountSpend, SpendPeriod } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';

export function costMeterLedger(dshDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.HABBLAUD_DSH_LEDGER?.trim() || join(dshDir, 'storages', 'cost-meter', 'ledger.json');
}

/** Saldo atual gravado pelo plugin mod/dsh-habblaud-uso (o que o cost-meter consultou por último). */
export function habblaudBalanceFile(dshDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.HABBLAUD_DSH_BALANCE?.trim() || join(dshDir, 'storages', 'habblaud', 'balance.json');
}

/**
 * Aplica o arquivo do dsh-habblaud-uso ao gasto: saldo "ok" substitui o do livro-caixa (live); "error"/"off"
 * ficam em balanceStatus. Formato desconhecido: não mexe.
 */
export function applyBalanceFile(spend: AccountSpend, raw: unknown): AccountSpend {
  const j = rec(raw);
  if (!j || j.source !== 'dsh-cost-meter') return spend;
  if (j.status === 'ok' && typeof j.total === 'number' && Number.isFinite(j.total)) {
    const currency = typeof j.currency === 'string' && j.currency ? j.currency.toUpperCase() : spend.currency;
    return {
      ...spend,
      balance: { total: j.total, currency, at: num(j.fetchedAt) || num(j.writtenAt), granted: num(j.granted), toppedUp: num(j.toppedUp), live: true },
      balanceStatus: undefined,
    };
  }
  if (j.status === 'error' || j.status === 'off') return { ...spend, balanceStatus: j.status };
  return spend;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function localDate(at: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

function empty(): SpendPeriod {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, cost: 0 };
}

/** Campo do custo na moeda do plugin: "CNY" -> costCny; USD (moeda dos preços) -> cost. */
function costKey(currency: string): string {
  const c = currency.toUpperCase();
  return c === 'USD' ? 'cost' : `cost${c.charAt(0)}${c.slice(1).toLowerCase()}`;
}

function add(into: SpendPeriod, r: Rec, key: string): void {
  into.input += num(r.input);
  into.output += num(r.output);
  into.cacheRead += num(r.cacheRead);
  into.cacheWrite += num(r.cacheWrite);
  into.calls += num(r.calls);
  into.cost += num(r[key] ?? (key === 'cost' ? 0 : r.cost));
}

export const tokensOf = (p: { input: number; output: number; cacheRead: number; cacheWrite: number }): number => p.input + p.output + p.cacheRead + p.cacheWrite;

/** Resume o livro-caixa (já lido como JSON) no dia `now` (data local). undefined = formato desconhecido. */
export function summarizeLedger(raw: unknown, now: Date, fetchedAt: number): AccountSpend | undefined {
  const j = rec(raw);
  const days = rec(j?.days);
  if (!j || !days) return undefined;
  const config = rec(j.config);
  let currency = typeof config?.currency === 'string' && /^[A-Za-z]{3}$/.test(config.currency) ? config.currency.toUpperCase() : 'USD';
  let symbol = typeof config?.symbol === 'string' && config.symbol.length <= 4 ? config.symbol : currency === 'USD' ? '$' : currency;
  let key = costKey(currency);
  // Moeda sem o campo convertido nos dias (ex.: trocada há pouco): volta para o USD dos preços.
  const sample = Object.values(days).map(rec).find(Boolean);
  if (key !== 'cost' && sample && !(key in sample)) {
    currency = 'USD';
    symbol = '$';
    key = 'cost';
  }

  const today = localDate(now);
  const weekStart = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const month = today.slice(0, 7);
  const s: AccountSpend = { source: 'dsh-cost-meter', currency, symbol, today: empty(), week: empty(), month: empty(), models: [], fetchedAt };
  for (const [date, v] of Object.entries(days)) {
    const d = rec(v);
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date === today) add(s.today, d, key);
    if (date >= weekStart && date <= today) add(s.week, d, key);
    if (date.startsWith(month) && date <= today) add(s.month, d, key);
  }
  const models = rec(rec(days[today])?.byProviderModel);
  if (models) {
    s.models = Object.entries(models)
      .map(([name, v]) => {
        const p = empty();
        add(p, rec(v) ?? {}, key);
        return { name, tokens: tokensOf(p), cost: p.cost };
      })
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 4);
  }
  const b = rec(j.balanceRef);
  if (b && typeof b.total === 'number' && Number.isFinite(b.total)) {
    s.balance = { total: b.total, currency: typeof b.currency === 'string' ? b.currency : currency, at: num(b.at) };
  }
  return s;
}

/**
 * Acompanha o livro-caixa (relê quando o arquivo muda; a cada `everyMs`, e na virada do dia) e põe o gasto na conta.
 * Arquivo ausente ou ilegível: a conta fica sem gasto (o cartão diz como ligar).
 */
export class DshSpendWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sig = '';

  constructor(
    private readonly opts: {
      accounts: AccountsService;
      accountId: () => string | undefined;
      ledger: string;
      /** Arquivo do plugin dsh-habblaud-uso (saldo atual); opcional. */
      balance?: string;
      everyMs?: number;
      now?: () => Date;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.everyMs ?? 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Lê de novo se o arquivo ou o dia mudaram. Público para os testes. */
  tick(): void {
    const id = this.opts.accountId();
    if (!id) return;
    const now = this.opts.now?.() ?? new Date();
    let mtime: number;
    let bal = '';
    if (this.opts.balance) {
      try {
        const b = statSync(this.opts.balance);
        bal = `${b.mtimeMs}|${b.size}`;
      } catch {
        bal = '-';
      }
    }
    try {
      const st = statSync(this.opts.ledger);
      mtime = st.mtimeMs;
      const sig = `${id}|${mtime}|${st.size}|${localDate(now)}|${bal}`;
      if (sig === this.sig) return;
      this.sig = sig;
    } catch {
      this.sig = '';
      this.opts.accounts.setSpend(id, undefined);
      return;
    }
    try {
      let spend = summarizeLedger(JSON.parse(readFileSync(this.opts.ledger, 'utf8')), now, Math.round(mtime));
      if (spend && this.opts.balance && bal !== '-') {
        try {
          spend = applyBalanceFile(spend, JSON.parse(readFileSync(this.opts.balance, 'utf8')));
        } catch {
          // Arquivo pela metade: fica o saldo do livro-caixa até a próxima volta.
        }
      }
      this.opts.accounts.setSpend(id, spend);
    } catch {
      // Gravação pela metade (o plugin escreve com frequência): tenta de novo na próxima volta.
      this.sig = '';
    }
  }
}
