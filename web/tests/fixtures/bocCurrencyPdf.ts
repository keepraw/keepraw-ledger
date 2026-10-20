import { buildSyntheticBocPdf } from './bocPdf'
import type { PdfDocument } from '../../src/parsers/types'

export function bocCurrencyLayout(currencies: string[] = ['USD'], options: { secondAccount?: boolean; foreignDetails?: boolean; foreignCurrency?: string } = {}): PdfDocument {
  const pdf = buildSyntheticBocPdf()
  const page = pdf.pages[0]!
  const template = page.items.filter(item => item.y === 244)
  page.items = page.items.filter(item => item.y !== 244)
  currencies.forEach((currency, index) => {
    page.items.push(...template.map(item => ({ ...item, y: 260 - index * 24,
      text: item.text === '人民币/RMB' ? ({ CNY: '人民币/RMB', USD: '美元/USD', HKD: '港币/HKD' }[currency] ?? currency) : item.text })))
  })
  if (options.secondAccount) {
    page.items.push({ text: '其他信用卡(卡号：9999)', x: 17, y: 200, width: 150, height: 10 })
    page.items.push(...template.map(item => ({ ...item, y: 180 })))
  }
  if (options.foreignDetails) {
    const detail = structuredClone(pdf.pages[1]!)
    detail.pageNumber = 3
    detail.items.unshift({ text: options.foreignCurrency === 'HKD' ? '港币交易明细/HKD Transaction Detailed List' : '美元交易明细/USD Transaction Detailed List', x: 17, y: 760, width: 260, height: 10 })
    pdf.pages.push(detail)
    pdf.numPages++
  }
  return pdf
}

/** Minimal text PDF with real ToUnicode mapping, so pdf.js extraction is exercised. */
export function encodeBocPdf(pdf: PdfDocument): Uint8Array {
  const characters = [...new Set(pdf.pages.flatMap(page => page.items.flatMap(item => Array.from(item.text))))]
  if (characters.length > 255) throw new Error('Synthetic PDF font exceeds single-byte capacity')
  const code = (char: string) => (characters.indexOf(char) + 1).toString(16).padStart(2, '0')
  const objects: string[] = []
  objects.push('<< /Type /Catalog /Pages 2 0 R >>')
  objects.push(`<< /Type /Pages /Kids [${pdf.pages.map((_, index) => `${6 + index * 2} 0 R`).join(' ')}] /Count ${pdf.pages.length} >>`)
  objects.push(`<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /CharProcs << ${characters.map((_, index) => `/g${index + 1} 4 0 R`).join(' ')} >> /Encoding << /Type /Encoding /Differences [1 ${characters.map((_, index) => `/g${index + 1}`).join(' ')}] >> /FirstChar 1 /LastChar ${characters.length} /Widths [${characters.map(() => '1000').join(' ')}] /ToUnicode 5 0 R /Resources << >> >>`)
  objects.push('<< /Length 9 >>\nstream\n1000 0 d0\nendstream')
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n${characters.length} beginbfchar\n${characters.map(char => `<${code(char)}> <${char.charCodeAt(0).toString(16).padStart(4, '0')}>`).join('\n')}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`
  const stream = (value: string) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`
  objects.push(stream(cmap))
  pdf.pages.forEach((page, index) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${7 + index * 2} 0 R >>`)
    const content = page.items.map(item => {
      const hex = Array.from(item.text).map(code).join('')
      return `BT /F1 10 Tf ${item.width / item.text.length * 10} Tz 1 0 0 1 ${item.x} ${page.height - item.y} Tm <${hex}> Tj ET`
    }).join('\n')
    objects.push(stream(content))
  })
  let output = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(output.length); output += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = output.length
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(output)
}
