import { useEffect, useRef, useState } from 'react'
import type { AgentTeamClientMemberStatus, AgentTeamModelSelection, AgentTeamUpdateMemberRequest } from '@wowyuarm/dsh-agent-team/types'
import type { TeamModelEffortOption, TeamModelProviderGroup, TeamSidebarProps } from './slots.ts'
import { Button, IconChevronDownOutline14, Input, Menu, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { mintRequestId } from './requests.ts'
import { TeamMemberMemoryDialog } from './TeamMemberMemoryDialog.tsx'
import createCss from './create.module.css'
import css from './sidebar.module.css'

/** Model option key inside one editor; opaque and resolved against the loaded groups. */
function modelKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Shared provider/model dropdown for the create and edit forms. The option
 * list rides the shared Menu primitive (one leading "follow Host default"
 * row, then non-selectable provider headings) with a capped, internally
 * scrolling card so growing model catalogs cannot stretch the dialog.
 */
export function ModelPickerField({ model, onModelChange, loadModels, disabled, t }: {
  readonly model: AgentTeamModelSelection | undefined
  readonly onModelChange: (choice: AgentTeamModelSelection | undefined) => void
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly disabled: boolean
  readonly t: TeamSidebarProps['t']
}) {
  const [groups, setGroups] = useState<readonly TeamModelProviderGroup[]>()
  const [modelsError, setModelsError] = useState<string>()
  const [open, setModelOpen] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  useEffect(() => {
    let mounted = true
    void loadModels().then(result => {
      if (!mounted) return
      if (result.ok) {
        setGroups(result.value.groups)
        setModelsError(undefined)
      } else {
        setModelsError(result.error.message)
      }
    })
    return () => { mounted = false }
  }, [loadModels])

  const items: MenuEntry[] = [{ id: '', label: t('modelFollowDefault') }]
  const byKey = new Map<string, { provider: string; id: string; name: string; efforts: readonly TeamModelEffortOption[] }>()
  for (const group of groups ?? []) {
    items.push({ type: 'label', id: `model-group:${group.id}`, text: group.name })
    for (const entry of group.models) {
      const key = modelKey(group.id, entry.id)
      byKey.set(key, { provider: group.id, id: entry.id, name: entry.name, efforts: entry.reasoning?.efforts ?? [] })
      items.push({ id: key, label: entry.name })
    }
  }
  const selectedModelKey = model === undefined ? '' : modelKey(model.provider, model.model)
  const triggerLabel = model === undefined
    ? t('modelFollowDefault')
    : byKey.get(selectedModelKey)?.name ?? `${model.provider} / ${model.model}`
  // The effort sub-row only makes sense for a pinned model with adapter-exposed
  // efforts; following the Host default inherits the operator's whole selection.
  const efforts = model === undefined ? [] : byKey.get(selectedModelKey)?.efforts ?? []
  const effortItems: MenuEntry[] = [{ id: '', label: t('effortFollowDefault') }, ...efforts.map(effort => ({ id: effort.id, label: effort.name }))]
  const selectedEffort = model?.reasoningEffort ?? ''
  const effortTriggerLabel = model === undefined || selectedEffort === ''
    ? t('effortFollowDefault')
    : efforts.find(effort => effort.id === selectedEffort)?.name ?? selectedEffort

  return <div className={createCss.field}>
    <span>{t('memberModel')}</span>
    {groups === undefined && modelsError === undefined && <small className={css.editHint}>{t('modelsLoading')}</small>}
    {modelsError !== undefined && <small className={css.editHint}>{t('modelsLoadFailed', { message: modelsError })}</small>}
    {groups !== undefined && (
      <Menu
        open={open}
        portal
        className={createCss.menuCap!}
        items={items}
        selectedId={selectedModelKey}
        onSelect={key => {
          setModelOpen(false)
          const choice = byKey.get(key)
          onModelChange(choice === undefined ? undefined : { provider: choice.provider, model: choice.id })
        }}
        onClose={() => { setModelOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('memberModel')}
            aria-haspopup="listbox"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => { setModelOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{triggerLabel}</span>
            <span className={`${createCss.chevron!} ${open ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
          </button>
        }
      />
    )}
    {model !== undefined && efforts.length > 0 && (
      <Menu
        open={effortOpen}
        portal
        className={createCss.menuCap!}
        items={effortItems}
        selectedId={selectedEffort}
        onSelect={key => {
          setEffortOpen(false)
          onModelChange(key === ''
            ? { provider: model.provider, model: model.model }
            : { provider: model.provider, model: model.model, reasoningEffort: key as NonNullable<AgentTeamModelSelection['reasoningEffort']> })
        }}
        onClose={() => { setEffortOpen(false) }}
        anchor={
          <button
            type="button"
            className={createCss.selectTrigger!}
            aria-label={t('reasoningEffort')}
            aria-haspopup="listbox"
            aria-expanded={effortOpen}
            disabled={disabled}
            onClick={() => { setEffortOpen(value => !value) }}
          >
            <span className={createCss.selectValue}>{`${t('reasoningEffort')} · ${effortTriggerLabel}`}</span>
            <span className={`${createCss.chevron!} ${effortOpen ? createCss.chevronOpen! : ''}`} aria-hidden><IconChevronDownOutline14 /></span>
          </button>
        }
      />
    )}
  </div>
}

/**
 * Agent editor: handle, description, and per-Member model selection commit
 * through one durable update. Channel membership is managed from the Channel
 * side, not here.
 */
export function AgentEditorDialog({ status, updateMember, loadModels, loadChannels, workspaces, canDemote: canDemoteProp, onCommitted, onClose, getMemberMemory, updateMemberMemory, t }: {
  readonly status: AgentTeamClientMemberStatus
  readonly updateMember: TeamSidebarProps['updateMember']
  readonly loadModels: TeamSidebarProps['loadModels']
  readonly loadChannels?: TeamSidebarProps['loadChannels'] | undefined
  readonly workspaces?: readonly { readonly workspaceId: any }[] | undefined
  readonly canDemote?: boolean
  readonly onCommitted: () => Promise<void> | void
  readonly onClose: () => void
  readonly getMemberMemory?: TeamSidebarProps['getMemberMemory'] | undefined
  readonly updateMemberMemory?: TeamSidebarProps['updateMemberMemory'] | undefined
  readonly t: TeamSidebarProps['t']
}) {
  const memberId = status.member.memberId
  const [handle, setHandle] = useState(status.member.handle)
  const [description, setDescription] = useState(status.member.description)
  const [model, setModel] = useState<AgentTeamModelSelection | undefined>(status.member.model)
  const initialScope: 'workspace' | 'global' = status.member.isGlobal ? 'global' : 'workspace'
  const [scope, setScope] = useState<'workspace' | 'global'>(initialScope)
  const [canDemote, setCanDemote] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [memoryOpen, setMemoryOpen] = useState(false)
  const pendingRequest = useRef<AgentTeamUpdateMemberRequest>()

  useEffect(() => {
    if (canDemoteProp !== undefined) return
    if (!status.member.isGlobal || !loadChannels || !workspaces) return
    let cancelled = false
    const checkForeignEnrollment = async () => {
      const foreignWorkspaces = workspaces.filter(w => w.workspaceId !== status.member.workspaceId)
      for (const fw of foreignWorkspaces) {
        try {
          const res = await loadChannels({ workspaceId: fw.workspaceId })
          if (res.ok && res.value.members.some(m => m.memberId === status.member.memberId)) {
            if (!cancelled) setCanDemote(false)
            return
          }
        } catch {
          // Ignore check failure; ledger will enforce if demotion attempted
        }
      }
      if (!cancelled) setCanDemote(true)
    }
    void checkForeignEnrollment()
    return () => { cancelled = true }
  }, [canDemoteProp, status.member.isGlobal, status.member.memberId, status.member.workspaceId, loadChannels, workspaces])

  const effectiveCanDemote = canDemoteProp !== undefined ? canDemoteProp : canDemote
  const dirty = handle.trim() !== status.member.handle || description.trim() !== status.member.description
    || !sameModel(model, status.member.model)
    || scope !== initialScope
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalizedHandle = handle.trim()
    const normalizedDescription = description.trim()
    if (saving || !dirty || normalizedHandle.length === 0) return
    const isGlobal = scope === 'global'
    const payload = {
      memberId,
      handle: normalizedHandle,
      description: normalizedDescription,
      isGlobal,
      ...(model === undefined ? {} : { model }),
      // The editor owns no capabilities UI, but an absent field would clear a
      // Remote-written override; echo the stored intent through the edit.
      ...(status.member.capabilities === undefined ? {} : { capabilities: status.member.capabilities }),
    }
    const samePending = pendingRequest.current !== undefined && pendingRequest.current.memberId === payload.memberId
      && pendingRequest.current.handle === payload.handle && pendingRequest.current.description === payload.description
      && pendingRequest.current.isGlobal === payload.isGlobal
      && sameModel(pendingRequest.current.model, model)
    const request: AgentTeamUpdateMemberRequest = samePending ? pendingRequest.current! : {
      requestId: mintRequestId(),
      ...payload,
    }
    pendingRequest.current = request
    setSaving(true)
    setError(undefined)
    try {
      const result = await updateMember(request)
      if (result.ok) {
        pendingRequest.current = undefined
        await onCommitted()
        onClose()
      } else {
        setError(result.error.message)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('editAgent')}
      description={`@${status.member.handle} · ${status.member.isGlobal ? t('globalAgent') : t('workspaceAgent')}`}
      closeLabel={t('close')}
      contentClassName={createCss.dialogContent!}
      footer={<><Button variant="outline" disabled={saving} onClick={onClose}>{t('cancel')}</Button><Button type="submit" form="team-agent-edit-form" variant="primary" disabled={saving || !dirty || handle.trim().length === 0}>{saving ? t('editSaving') : t('editSave')}</Button></>}
    >
      <form id="team-agent-edit-form" className={createCss.form} onSubmit={event => { void submit(event) }}>
        <label className={createCss.field}>
          <span>{t('agentName')}</span>
          <Input className={createCss.input!} value={handle} onChange={event => { setHandle(event.target.value); pendingRequest.current = undefined }} disabled={saving} autoFocus />
        </label>
        <label className={createCss.field}>
          <span>{t('agentDescription')}{t('optionalSuffix')}</span>
          <Input className={createCss.input!} value={description} placeholder={t('agentDescriptionPlaceholder')} onChange={event => { setDescription(event.target.value); pendingRequest.current = undefined }} disabled={saving} />
          <small style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 4, lineHeight: '16px' }}>
            {t('agentRoleDescriptionHint', { handle: handle.trim() || 'agent' })}
          </small>
        </label>
        {getMemberMemory !== undefined && updateMemberMemory !== undefined && (
          <div className={createCss.field}>
            <Button
              variant="outline"
              type="button"
              disabled={saving}
              onClick={() => { setMemoryOpen(true) }}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('viewMemory')}
            </Button>
          </div>
        )}
        <ModelPickerField model={model} onModelChange={choice => { pendingRequest.current = undefined; setModel(choice) }} loadModels={loadModels} disabled={saving} t={t} />
        <div className={createCss.field}>
          <span>{t('agentScope')}</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} role="radiogroup" aria-label={t('agentScope')}>
            {status.member.isGlobal && !effectiveCanDemote ? (
              <Tooltip label={t('scopeDemoteDisabledTooltip')}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, opacity: 0.5, cursor: 'not-allowed' }}>
                  <input
                    type="radio"
                    name="agent-scope"
                    value="workspace"
                    checked={scope === 'workspace'}
                    disabled
                  />
                  <div>
                    <strong>{t('workspaceAgent')}</strong>
                    <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('workspaceAgentDesc')}</div>
                  </div>
                </label>
              </Tooltip>
            ) : (
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: saving ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio"
                  name="agent-scope"
                  value="workspace"
                  checked={scope === 'workspace'}
                  onChange={() => { setScope('workspace'); pendingRequest.current = undefined }}
                  disabled={saving}
                />
                <div>
                  <strong>{t('workspaceAgent')}</strong>
                  <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('workspaceAgentDesc')}</div>
                </div>
              </label>
            )}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: saving ? 'not-allowed' : 'pointer' }}>
              <input
                type="radio"
                name="agent-scope"
                value="global"
                checked={scope === 'global'}
                onChange={() => { setScope('global'); pendingRequest.current = undefined }}
                disabled={saving}
              />
              <div>
                <strong>{t('globalAgent')}</strong>
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>{t('globalAgentDesc')}</div>
              </div>
            </label>
          </div>
          {status.member.isGlobal && !effectiveCanDemote && (
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-warning-primary)', marginTop: 4 }}>
              {t('scopeCannotDemoteNotice')}
            </div>
          )}
        </div>
        {error !== undefined && <p className={createCss.error} role="alert">{error}</p>}
      </form>
      {memoryOpen && getMemberMemory !== undefined && updateMemberMemory !== undefined && (
        <TeamMemberMemoryDialog
          status={status}
          getMemberMemory={getMemberMemory}
          updateMemberMemory={updateMemberMemory}
          onClose={() => { setMemoryOpen(false) }}
          t={t}
        />
      )}
    </Modal>
  )
}

export function sameModel(left: AgentTeamModelSelection | undefined, right: AgentTeamModelSelection | undefined): boolean {
  if (left === undefined && right === undefined) return true
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}
