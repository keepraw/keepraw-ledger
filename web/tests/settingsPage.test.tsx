import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { parserCatalog } from '../src/parsers/registry'

vi.mock('../src/app/AppStore', () => ({
  useApp: () => ({
    state: {
      statements: [],
      transactions: [],
      imports: [],
      settings: { theme: 'light', demoMode: false, locale: 'zh-CN' },
      demoMode: false,
    },
    setSettings: vi.fn(),
    backup: vi.fn(),
    backupData: vi.fn(),
    backupFull: vi.fn(),
    restore: vi.fn(),
    archiveStatus: vi.fn().mockResolvedValue({ transactionCount: 0, importCount: 0, archivedCount: 0, missingCount: 0 }),
    clearData: vi.fn(),
    loadDemoData: vi.fn(),
  }),
}))

vi.mock('../src/db/repository', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/db/repository')>()
  return { ...mod, storageEstimate: vi.fn().mockResolvedValue(null) }
})

import { SettingsPage } from '../src/ui/pages/SettingsPage'

describe('Settings supported formats', () => {
  it('renders every registered bank from the parser registry', () => {
    render(<SettingsPage />)
    const table = screen.getByTestId('supported-parsers')
    const catalog = parserCatalog()
    expect(catalog).toHaveLength(6)

    for (const entry of catalog) {
      const row = screen.getByTestId(`parser-row-${entry.id}`)
      expect(within(row).getByText(entry.bankName)).toBeInTheDocument()
      // Parser id is shown for debugging.
      expect(within(row).getByText(entry.id)).toBeInTheDocument()
      // Every declared source type is displayed dynamically.
      for (const sourceType of entry.sourceTypes) {
        expect(row.textContent).toContain(sourceType)
      }
    }

    // The six expected banks are all present.
    for (const name of ['中国银行', '交通银行', '工商银行', '建设银行', '农业银行', '中信银行']) {
      expect(within(table).getByText(name)).toBeInTheDocument()
    }
    // Row count tracks the registry instead of a fixed constant.
    expect(within(table).getAllByTestId(/^parser-row-/)).toHaveLength(catalog.length)
  })

  it('does not hardcode the bank list in SettingsPage', () => {
    const source = readFileSync(join(process.cwd(), 'src/ui/pages/SettingsPage.tsx'), 'utf-8')
    // The page must read from the registry.
    expect(source).toMatch(/parserCatalog|PARSER_DEFINITIONS|PARSERS/)
    // No static bank rows remain.
    const supportedFormats = source.match(/<table[^>]*data-testid="supported-parsers"[\s\S]*?<\/table>/)?.[0]
    expect(supportedFormats).toBeDefined()
    for (const name of ['中国银行', '交通银行', '工商银行', '建设银行', '农业银行', '中信银行']) {
      expect(supportedFormats).not.toContain(name)
    }
    for (const id of ['boc_pdf', 'bocom_eml', 'icbc_eml', 'ccb_eml', 'abc_eml', 'citic_eml']) {
      expect(source).not.toContain(id)
    }
  })
})
