// Os formatos dos textos do app, em pt-BR.

const DOIS = (n: number) => String(n).padStart(2, '0')

/** O relógio da gravação: `00:42:10`. */
export function relogio(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${DOIS(Math.floor(s / 3600))}:${DOIS(Math.floor((s % 3600) / 60))}:${DOIS(s % 60)}`
}

/** A duração: `54 min`, `1 h 12 min`, `menos de 1 min`. */
export function duracao(ms: number | null): string {
  if (ms === null) return '—'
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 1) return 'menos de 1 min'
  if (minutos < 60) return `${minutos} min`
  const resto = minutos % 60
  return resto ? `${Math.floor(minutos / 60)} h ${resto} min` : `${Math.floor(minutos / 60)} h`
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

function mesmoDia(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Quando: `Hoje 09:00`, `Ontem 16:40`, `26 set 09:00`. */
export function quando(ts: number, agora: Date = new Date()): string {
  const data = new Date(ts)
  const hora = `${DOIS(data.getHours())}:${DOIS(data.getMinutes())}`
  if (mesmoDia(data, agora)) return `Hoje ${hora}`
  const ontem = new Date(agora)
  ontem.setDate(agora.getDate() - 1)
  if (mesmoDia(data, ontem)) return `Ontem ${hora}`
  return `${data.getDate()} ${MESES[data.getMonth()]} ${hora}`
}

/** A data longa do detalhe: `sáb 26 set 2026 · 09:00`. */
export function dataLonga(ts: number): string {
  const data = new Date(ts)
  return `${DIAS[data.getDay()]} ${data.getDate()} ${MESES[data.getMonth()]} ${data.getFullYear()} · ${DOIS(data.getHours())}:${DOIS(data.getMinutes())}`
}

/** O título sugerido na folha "Gravação salva": `sáb 26 set, 10:42`. */
export function tituloSugerido(ts: number): string {
  const data = new Date(ts)
  return `${DIAS[data.getDay()]} ${data.getDate()} ${MESES[data.getMonth()]}, ${DOIS(data.getHours())}:${DOIS(data.getMinutes())}`
}

/** Bytes: `10 MB`, `1,1 GB`. */
export function tamanho(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} GB`
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`
}

/** Taxa: `18 MB/s`, `640 kB/s`. */
export function taxa(bytesPorSegundo: number): string {
  if (bytesPorSegundo >= 1e6) return `${Math.round(bytesPorSegundo / 1e6)} MB/s`
  return `${Math.round(bytesPorSegundo / 1e3)} kB/s`
}

/** `1 marcador`, `3 marcadores`. */
export function marcadores(n: number): string {
  return n === 1 ? '1 marcador' : `${n} marcadores`
}
