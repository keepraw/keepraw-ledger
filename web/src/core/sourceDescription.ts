/** Source-format cleanup frozen for transaction identity compatibility. */
export function cleanSourceDescription(text: string, bank?: string): string {
  let value = (text ?? '').replace(/\s+/g, ' ').trim()
  if (bank === 'boc') {
    value = value.replace(/(?<![A-Za-z])C\s*H\s*N(?![A-Za-z])/gi, '')
    value = value.replace(/(?<![A-Za-z])C$/, '')
    value = value.replace(/^HN(?![A-Za-z])/, '')
    return value.replace(/\s*\/\s*$/, '').replace(/\s{2,}/g, ' ').trim()
  }
  return value.replace(/\s*\/\s*$/, '').trim()
}
