import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitText } from '../src/text.ts'

const points = (text: string): number => Array.from(text).length

/** True when no surrogate appears without its partner (lib is ES2022, so no String#isWellFormed). */
function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

test('a cut never splits a surrogate pair', () => {
  // One emoji straddles the 4000 boundary; the cut must move past it intact.
  const text = `${'a'.repeat(3999)}${'😀'.repeat(3)}`
  const pieces = splitText(text)
  assert.ok(pieces.length > 1)
  for (const piece of pieces) {
    assert.ok(wellFormed(piece), 'a piece contains a lone surrogate')
    assert.ok(points(piece) <= 4000)
  }
  assert.equal(pieces.join(''), text)
})

test('a long string with no natural break still splits within the limit', () => {
  const text = '😀'.repeat(9000)
  const pieces = splitText(text)
  assert.ok(pieces.length > 1)
  for (const piece of pieces) {
    assert.ok(points(piece) <= 4000, 'a piece exceeds the 4000 code-point limit')
    assert.ok(wellFormed(piece))
  }
  assert.equal(pieces.join(''), text)
})

test('a reply with spaces breaks at a space and keeps every word', () => {
  const text = Array.from({ length: 2000 }, (_, index) => `w${index}`).join(' ')
  const pieces = splitText(text, 500)
  assert.ok(pieces.length > 1)
  for (const piece of pieces) {
    assert.ok(points(piece) <= 500)
    assert.equal(piece, piece.trim(), 'a piece must not carry edge whitespace')
  }
  assert.equal(pieces.join(' '), text)
})
