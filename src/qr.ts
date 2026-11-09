/**
 * The iLink `qrcode_img_content` value is an HTML page URL, not an image;
 * `<img src>` cannot show it. Encode the URL into an SVG QR ourselves with the
 * vendored MIT encoder (qrcode-generator, Kazuhiko Arase).
 */
import qrcodeFactory from './vendor/qrcode.mjs'

export function qrSvgFor(url: string): string {
  const qr = qrcodeFactory(0, 'M') as { addData(data: string): void; make(): void; createSvgTag(options: Record<string, unknown>): string }
  qr.addData(url)
  qr.make()
  return qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true })
}
