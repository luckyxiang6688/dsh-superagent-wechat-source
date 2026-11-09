/** Splits one reply into WeChat-sized segments (code points, natural breaks). */

const codePoints = (text: string): string[] => Array.from(text)

export function splitText(text: string, limit = 4000): string[] {
  const max = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  if (codePoints(text).length <= max) return [text]
  const pieces: string[] = []
  let remaining = text
  while (remaining) {
    const points = codePoints(remaining)
    if (points.length <= max) { pieces.push(remaining); break }
    const hard = points.slice(0, max).join('')
    const minimum = Math.ceil(hard.length * 0.55)
    let cut = hard.length
    for (const needle of ['\n\n', '\n', ' ']) {
      const index = hard.lastIndexOf(needle)
      if (index > 0 && index >= minimum) { cut = index + needle.length; break }
    }
    const piece = remaining.slice(0, cut).replace(/\s+$/, '')
    if (piece) pieces.push(piece)
    remaining = remaining.slice(cut).replace(/^\s+/, '')
  }
  return pieces
}
