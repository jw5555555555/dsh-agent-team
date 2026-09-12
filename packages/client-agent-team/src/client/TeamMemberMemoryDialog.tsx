import { useEffect, useState } from 'react'
import type { AgentTeamClientMemberStatus } from '@wowyuarm/dsh-agent-team/types'
import type { TeamSidebarProps } from './slots.ts'
import { Button, IconCheckOutline16, IconCopyOutline16, IconEditOutline16, Modal, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import createCss from './create.module.css'

const MAX_MEMORY_BYTES = 8 * 1024

function byteLengthOf(str: string): number {
  return new TextEncoder().encode(str).length
}

export function TeamMemberMemoryDialog({
  status,
  getMemberMemory,
  updateMemberMemory,
  onClose,
  t,
}: {
  readonly status: AgentTeamClientMemberStatus
  readonly getMemberMemory: TeamSidebarProps['getMemberMemory']
  readonly updateMemberMemory: TeamSidebarProps['updateMemberMemory']
  readonly onClose: () => void
  readonly t: TeamSidebarProps['t']
}) {
  const memberId = status.member.memberId
  const handle = status.member.handle
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [memoryPath, setMemoryPath] = useState('')
  const [content, setContent] = useState('')
  const [byteSize, setByteSize] = useState(0)
  const [notesCount, setNotesCount] = useState(0)
  const [skillsCount, setSkillsCount] = useState(0)
  const [exists, setExists] = useState(false)

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState(false)
  const [saveAlert, setSaveAlert] = useState<string>()

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(undefined)
    void getMemberMemory({ memberId }).then(result => {
      if (!active) return
      setLoading(false)
      if (result.ok) {
        setMemoryPath(result.value.memoryPath)
        setContent(result.value.content)
        setDraft(result.value.content)
        setByteSize(result.value.byteSize)
        setNotesCount(result.value.notesCount)
        setSkillsCount(result.value.skillsCount)
        setExists(result.value.exists)
      } else {
        setError(result.error.message)
      }
    }).catch(cause => {
      if (!active) return
      setLoading(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { active = false }
  }, [memberId, getMemberMemory])

  const copyPath = async () => {
    if (!memoryPath) return
    try {
      await navigator.clipboard.writeText(`${memoryPath}/memory.md`)
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 2000)
    } catch {
      // ignore
    }
  }

  const handleStartEdit = () => {
    setDraft(content)
    setSaveAlert(undefined)
    setEditing(true)
  }

  const handleCancelEdit = () => {
    setDraft(content)
    setSaveAlert(undefined)
    setEditing(false)
  }

  const draftBytes = byteLengthOf(draft)
  const isOverBudget = draftBytes > MAX_MEMORY_BYTES

  const handleSave = async () => {
    if (saving || isOverBudget) return
    setSaving(true)
    setSaveAlert(undefined)
    try {
      const res = await updateMemberMemory({ memberId, content: draft })
      if (res.ok) {
        setContent(draft)
        setByteSize(res.value.byteSize)
        setExists(true)
        setEditing(false)
        setSaveAlert(t('saveMemorySuccess'))
        setTimeout(() => { setSaveAlert(undefined) }, 3000)
      } else {
        setSaveAlert(t('saveMemoryFailed', { message: res.error.message }))
      }
    } catch (cause) {
      setSaveAlert(t('saveMemoryFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={editing ? handleCancelEdit : onClose}
      title={t('agentMemoryTitle', { name: handle })}
      description={status.member.description || undefined}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={
        editing ? (
          <>
            <Button variant="outline" disabled={saving} onClick={handleCancelEdit}>
              {t('cancelEdit')}
            </Button>
            <Button
              variant="primary"
              disabled={saving || isOverBudget}
              onClick={() => { void handleSave() }}
            >
              {saving ? t('savingMemory') : t('saveMemory')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={loading}
              icon={<IconEditOutline16 />}
              onClick={handleStartEdit}
            >
              {t('editMemory')}
            </Button>
          </>
        )
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {/* Path and Stats Bar */}
        {memoryPath !== '' && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            background: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,0.06))',
            padding: '8px 12px',
            borderRadius: 6,
            fontSize: 12,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                {t('memoryPathLabel')}<code style={{ color: 'var(--dsw-alias-label-primary)' }}>{memoryPath}/memory.md</code>
              </span>
              <Button
                variant="ghost"
                size="sm"
                icon={copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
                onClick={() => { void copyPath() }}
              >
                {copied ? t('copiedCode') : t('copyCode')}
              </Button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Pill style={{ fontSize: 11, height: 20, padding: '0 6px' }}>
                {t('memoryBudget', { bytes: editing ? draftBytes.toLocaleString() : byteSize.toLocaleString() })}
              </Pill>
              {notesCount > 0 && (
                <Pill style={{ fontSize: 11, height: 20, padding: '0 6px' }}>
                  {notesCount} notes
                </Pill>
              )}
              {skillsCount > 0 && (
                <Pill style={{ fontSize: 11, height: 20, padding: '0 6px' }}>
                  {skillsCount} skills
                </Pill>
              )}
            </div>
          </div>
        )}

        {/* Loading state */}
        {loading && <p style={{ color: 'var(--dsw-alias-label-secondary)', margin: '16px 0' }}>{t('loadingMemory')}</p>}

        {/* Fetch Error */}
        {error !== undefined && (
          <p className={createCss.error} role="alert">
            {t('loadMemoryFailed', { message: error })}
          </p>
        )}

        {/* Save feedback */}
        {saveAlert !== undefined && (
          <div style={{
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: 12,
            background: saveAlert.includes('失败') || saveAlert.includes('Failed')
              ? 'rgba(239, 68, 68, 0.1)'
              : 'rgba(34, 197, 94, 0.1)',
            color: saveAlert.includes('失败') || saveAlert.includes('Failed')
              ? 'var(--dsw-alias-state-danger-primary, #ef4444)'
              : 'var(--dsw-alias-state-success-primary, #22c55e)',
          }}>
            {saveAlert}
          </div>
        )}

        {/* Over budget warning */}
        {editing && isOverBudget && (
          <div style={{
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: 12,
            background: 'rgba(239, 68, 68, 0.1)',
            color: 'var(--dsw-alias-state-danger-primary, #ef4444)',
          }}>
            {t('memoryOverBudget', { bytes: draftBytes.toLocaleString() })}
          </div>
        )}

        {/* Content View or Edit */}
        {!loading && error === undefined && (
          editing ? (
            <textarea
              value={draft}
              onChange={e => { setDraft(e.target.value) }}
              rows={16}
              disabled={saving}
              placeholder="# Personal memory / SOP..."
              style={{
                width: '100%',
                boxSizing: 'border-box',
                fontFamily: 'var(--dsw-alias-font-mono, monospace)',
                fontSize: 12,
                lineHeight: '18px',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.2))',
                background: 'var(--dsw-alias-surface-primary, transparent)',
                color: 'var(--dsw-alias-label-primary, inherit)',
                resize: 'vertical',
                minHeight: 240,
                maxHeight: 480,
                outline: 'none',
              }}
            />
          ) : (
            exists && content.trim().length > 0 ? (
              <pre style={{
                margin: 0,
                padding: '12px 14px',
                borderRadius: 6,
                background: 'var(--dsw-alias-surface-secondary, rgba(127,127,127,0.04))',
                border: '1px solid var(--dsw-alias-border-primary, rgba(127,127,127,0.15))',
                fontFamily: 'var(--dsw-alias-font-mono, monospace)',
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--dsw-alias-label-primary)',
                maxHeight: 380,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {content}
              </pre>
            ) : (
              <div style={{
                padding: '24px 16px',
                textAlign: 'center',
                color: 'var(--dsw-alias-label-secondary)',
                fontSize: 13,
                lineHeight: '20px',
                border: '1px dashed var(--dsw-alias-border-primary, rgba(127,127,127,0.2))',
                borderRadius: 6,
              }}>
                <p style={{ margin: '0 0 12px 0' }}>{t('agentMemoryEmpty')}</p>
                <Button size="sm" variant="outline" icon={<IconEditOutline16 />} onClick={handleStartEdit}>
                  {t('editMemory')}
                </Button>
              </div>
            )
          )
        )}
      </div>
    </Modal>
  )
}
