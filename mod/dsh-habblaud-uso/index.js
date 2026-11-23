// Saldo do DeepSeek para o Habblaud: reaproveita o plugin dsh-cost-meter (o "usage" do DSH), que já consulta o
// saldo da conta com a chave guardada no próprio DSH. Este plugin não vê chave nenhuma nem vai à rede:
//
// 1. A cada 60 s pede ao serviço do cost-meter o estado local (ctx.costMeter.getLocalState(): devolve na hora o
//    saldo em cache dele e, se estiver velho, ele mesmo renova em segundo plano).
// 2. Grava só os números do saldo em <DSH_HOME>/storages/habblaud/balance.json (escrita atômica: .tmp + rename).
//    O Habblaud lê esse arquivo ao lado do livro-caixa do cost-meter e mostra o saldo no cartão da conta.
//
// Regras: nada lança para fora; uma rodada por vez; arquivo igual não é regravado.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['costMeter']

const POLL_MS = 60_000
const FIRST_MS = 3_000

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function dshHome() {
  const env = process.env.DSH_HOME?.trim()
  return env || join(homedir(), '.dsh')
}

/** Só o que o Habblaud mostra: nada de mensagens, rótulos de chave ou contas. */
export function balanceRecord(state, now = Date.now()) {
  const b = state && typeof state === 'object' ? state.balance : undefined
  if (!b || typeof b !== 'object') return undefined
  const status = ['ok', 'error', 'off'].includes(b.status) ? b.status : 'off'
  const out = { source: 'dsh-cost-meter', status, writtenAt: now }
  const fetchedAt = num(b.fetchedAt)
  if (fetchedAt) out.fetchedAt = fetchedAt
  if (status === 'ok') {
    out.currency = typeof b.currency === 'string' ? b.currency.slice(0, 8) : ''
    out.total = num(b.totalBalance) ?? 0
    out.granted = num(b.grantedBalance) ?? 0
    out.toppedUp = num(b.toppedUpBalance) ?? 0
  }
  return out
}

export function apply(ctx, config = {}) {
  const dir = typeof config.dir === 'string' && config.dir ? config.dir : join(dshHome(), 'storages', 'habblaud')
  const file = join(dir, 'balance.json')
  let stopped = false
  let busy = false
  let timer
  let last = ''

  async function round() {
    const state = await ctx.costMeter.getLocalState()
    const rec = balanceRecord(state)
    if (!rec) return
    // Sem mudar os números, só regrava de vez em quando (o Habblaud usa writtenAt para saber que o plugin vive).
    const sig = JSON.stringify({ ...rec, writtenAt: Math.floor(rec.writtenAt / 600_000) })
    if (sig === last) return
    await mkdir(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8')
    await rename(tmp, file)
    last = sig
  }

  function schedule(ms) {
    if (stopped) return
    timer = setTimeout(async () => {
      if (!busy) {
        busy = true
        try {
          await round()
        } catch (err) {
          ctx.logger?.debug?.(`habblaud-uso: ${err?.message ?? err}`)
        } finally {
          busy = false
        }
      }
      schedule(POLL_MS)
    }, ms)
    timer.unref?.()
  }

  ctx.effect(() => {
    stopped = false
    // O arquivo de uma sessão anterior vale como ponto de partida (evita regravar igual logo ao iniciar).
    readFile(file, 'utf8')
      .then((t) => {
        const j = JSON.parse(t)
        last = JSON.stringify({ ...j, writtenAt: Math.floor((j.writtenAt ?? 0) / 600_000) })
      })
      .catch(() => {})
    schedule(FIRST_MS)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, 'habblaud-uso: balance poll')
}
