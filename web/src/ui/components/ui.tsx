import type { ReactNode } from 'react'
import { canAcknowledgeStatement } from '../../core/statementState'
import { formatMinor } from '../../core/money'
import {
  REVIEW_FLAG_LABELS,
  type Direction,
  type ReconciliationCheck,
  type ReviewFlag,
  type ReviewStatus,
  type Statement,
} from '../../core/types'

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted' | 'demo'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Stat({
  label,
  value,
  hint,
  tone,
  badge,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'pos' | 'neg'
  badge?: ReactNode
}) {
  return (
    <div className="card stat">
      <span className="stat-label">
        {label}
        {badge}
      </span>
      <span className={`stat-value ${tone === 'neg' ? 'amount-neg' : 'amount-pos'}`}>{value}</span>
      {hint ? <span className="stat-hint">{hint}</span> : null}
    </div>
  )
}

export function Amount({ minor, currency = 'CNY' }: { minor: number; currency?: string }) {
  return (
    <span className={`num ${minor < 0 ? 'amount-neg' : ''}`} style={{ display: 'block' }}>
      {formatMinor(minor, currency)}
    </span>
  )
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {hint ? <p style={{ marginTop: 6 }}>{hint}</p> : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  )
}

export function DemoBadge() {
  return <Badge tone="demo">演示数据</Badge>
}

const REVIEW_TONE: Record<ReviewStatus, 'ok' | 'warn' | 'danger' | 'muted'> = {
  ok: 'ok',
  pending: 'warn',
  confirmed: 'info' as 'ok',
  rejected: 'muted',
}

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  const labels: Record<ReviewStatus, string> = {
    ok: '正常',
    pending: '待复核',
    confirmed: '已确认',
    rejected: '已排除',
  }
  const tone = status === 'confirmed' ? 'info' : REVIEW_TONE[status]
  return <Badge tone={tone}>{labels[status]}</Badge>
}

export function DirectionBadge({ direction }: { direction: Direction }) {
  return <Badge tone={direction === 'credit' ? 'ok' : 'muted'}>{direction === 'credit' ? '贷记' : '借记'}</Badge>
}

export function FlagList({ flags }: { flags: ReviewFlag[] }) {
  const activeFlags = flags.filter(flag => flag !== 'uncategorized')
  if (activeFlags.length === 0) return <span className="subtle">—</span>
  return (
    <div className="tag-list">
      {activeFlags.map((flag) => (
        <Badge key={flag} tone={flag === 'suspected_duplicate' ? 'warn' : 'danger'}>
          {REVIEW_FLAG_LABELS[flag]}
        </Badge>
      ))}
    </div>
  )
}

const CHECK_TONE: Record<ReconciliationCheck['status'], 'ok' | 'warn' | 'danger' | 'muted'> = {
  passed: 'ok',
  mismatch: 'danger',
  missing: 'warn',
  skipped: 'muted',
}

const CHECK_LABEL: Record<ReconciliationCheck['status'], string> = {
  passed: '通过',
  mismatch: '存在差额',
  missing: '缺少信息',
  skipped: '未检查',
}

export function StatementStatusBadge({ statement }: { statement: Statement }) {
  if (statement.reconciliationAcknowledged && canAcknowledgeStatement(statement)) return <Badge tone="info">已确认无需对账</Badge>
  if (statement.status === 'reconciled') return <Badge tone="ok">对账通过</Badge>
  if (statement.status === 'imported') return <Badge tone="info">历史导入</Badge>
  if (statement.reconciliation.status === 'mismatch') return <Badge tone="danger">对账存在差额</Badge>
  return <Badge tone="warn">缺少汇总信息</Badge>
}

export function ReconciliationChecks({ statement }: { statement: Statement }) {
  return (
    <div className="check-list">
      {statement.reconciliation.checks.map((check) => (
        <div className="check" key={check.id}>
          <Badge tone={CHECK_TONE[check.status]}>{CHECK_LABEL[check.status]}</Badge>
          <div>
            <div>{check.label}</div>
            <div className="check-detail">{check.detail}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function BarChart({
  data,
  formatValue,
  ariaLabel,
}: {
  data: Array<{ id: string; label: string; value: number; caption?: string; accessibleLabel?: string }>
  formatValue: (value: number) => string
  ariaLabel: string
}) {
  const max = Math.max(1, ...data.map((entry) => entry.value))
  return (
    <div className="bar-chart-scroll" role="region" aria-label={ariaLabel} tabIndex={0}>
      <div className="bar-chart">
        {data.map((entry) => (
          <div
            className="bar-col"
            key={entry.id}
            data-testid="monthly-bar"
            data-chart-key={entry.id}
            role="group"
            aria-label={entry.accessibleLabel ?? `${entry.label}，${formatValue(entry.value)}`}
          >
            <span className="bar-value">{formatValue(entry.value)}</span>
            <div className="bar-stack">
              <div className="bar" style={{ height: `${Math.max(2, (entry.value / max) * 100)}%` }} />
            </div>
            <span className="bar-label">{entry.label}</span>
            {entry.caption ? <span className="bar-label bar-caption">{entry.caption}</span> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

export function HorizontalBars({
  data,
  formatValue,
}: {
  data: Array<{ label: string; value: number }>
  formatValue: (value: number) => string
}) {
  const max = Math.max(1, ...data.map((entry) => entry.value))
  if (data.length === 0) return <EmptyState title="暂无数据" />
  return (
    <div>
      {data.map((entry) => (
        <div className="hbar" key={entry.label} data-label={entry.label} data-value={entry.value}>
          <span className="subtle hbar-label">{entry.label}</span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${Math.max(2, (entry.value / max) * 100)}%` }} />
          </span>
          <span className="bar-value hbar-value">{formatValue(entry.value)}</span>
        </div>
      ))}
    </div>
  )
}
