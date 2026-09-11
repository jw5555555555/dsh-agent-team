// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { AgentEditorDialog } from '../src/client/TeamMemberEditor.tsx'
import { TeamComposer } from '../src/client/TeamComposer.tsx'
import { zh, en } from '../src/client/locales.ts'
import type { AgentTeamClientMemberStatus, AgentTeamMemberId } from '@wowyuarm/dsh-agent-team/types'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

function ComposerTestHarness({ members }: { members: readonly AgentTeamClientMemberStatus[] }) {
  const [draft, setDraft] = useState('')
  const [recipients, setRecipients] = useState<ReadonlySet<AgentTeamMemberId>>(new Set())
  const t = (key: string) => (zh as Record<string, string>)[key] ?? key
  return (
    <TeamComposer
      members={members}
      draft={draft}
      recipients={recipients}
      pending={false}
      onDraftChange={setDraft}
      onRecipientsChange={setRecipients}
      onSubmit={vi.fn()}
      t={t as any}
    />
  )
}

describe('Global Agent Web Client UI Integration (Milestone 3)', () => {
  it('supports selecting Global Scope when creating an Agent', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))

    const addAgentTrigger = await b.view.findByRole('button', { name: '添加 Agent' })
    fireEvent.click(addAgentTrigger)

    const modal = await b.view.findByRole('dialog', { name: '添加 Agent' })
    expect(modal).toBeTruthy()

    // Verify scope selector is rendered with default workspace scope
    const workspaceRadio = within(modal).getByRole('radio', { name: /工作区 Agent/ }) as HTMLInputElement
    const globalRadio = within(modal).getByRole('radio', { name: /全局 Agent/ }) as HTMLInputElement
    expect(workspaceRadio.checked).toBe(true)
    expect(globalRadio.checked).toBe(false)

    // Fill details and select Global Agent
    const nameInput = within(modal).getByLabelText('名称')
    fireEvent.change(nameInput, { target: { value: 'global-architect' } })
    fireEvent.change(within(modal).getByLabelText(/说明/), { target: { value: 'Unified cross-workspace architecture' } })
    fireEvent.click(globalRadio)
    expect(globalRadio.checked).toBe(true)
    expect(workspaceRadio.checked).toBe(false)

    // Submit
    fireEvent.click(within(modal).getByRole('button', { name: '创建 Agent' }))

    await waitFor(() => {
      expect(b.addMember).toHaveBeenCalledWith(expect.objectContaining({
        handle: 'global-architect',
        description: 'Unified cross-workspace architecture',
        isGlobal: true,
      }))
    })

    await b.runtime.dispose()
  })

  it('submits without isGlobal when creating a Workspace Agent', async () => {
    const b = await runtimeWithTeam({ initialChannels: true })
    fireEvent.click(b.view.getByRole('button', { name: '团队' }))

    const addAgentTrigger = await b.view.findByRole('button', { name: '添加 Agent' })
    fireEvent.click(addAgentTrigger)

    const modal = await b.view.findByRole('dialog', { name: '添加 Agent' })
    const workspaceRadio = within(modal).getByRole('radio', { name: /工作区 Agent/ }) as HTMLInputElement
    expect(workspaceRadio.checked).toBe(true)

    const nameInput = within(modal).getByLabelText('名称')
    fireEvent.change(nameInput, { target: { value: 'local-tester' } })

    fireEvent.click(within(modal).getByRole('button', { name: '创建 Agent' }))

    await waitFor(() => {
      expect(b.addMember).toHaveBeenCalledWith(expect.objectContaining({
        handle: 'local-tester',
      }))
      const lastCall = b.addMember.mock.calls.at(-1)?.[0]
      expect(lastCall?.isGlobal).toBeUndefined()
    })

    await b.runtime.dispose()
  })

  it('visually distinguishes global agents with Global Pill badge across UI surfaces', async () => {
    const globalAgent = {
      memberId: 'member:global-bot',
      workspaceId: 'w1',
      handle: 'global-bot',
      presence: 'available' as const,
      isGlobal: true,
    }

    const b = await runtimeWithTeam({
      mode: 'team',
      workspaceId: 'w1',
      initialChannels: true,
      extraMembers: [globalAgent],
    })

    // 1. Sidebar Agent Row: Global badge is rendered
    await waitFor(() => expect(b.view.getByText('global-bot')).toBeTruthy())
    const agentRow = b.view.getByText('global-bot').closest('button')!
    expect(within(agentRow).getByText('全局')).toBeTruthy()

    // 2. Members Directory Modal: Global section & badge rendered
    const membersTrigger = b.view.getByRole('button', { name: '成员' })
    fireEvent.click(membersTrigger)

    const membersDialog = await b.view.findByRole('dialog', { name: '成员' })
    expect(within(membersDialog).getByRole('heading', { name: '全局 Agents' })).toBeTruthy()
    expect(within(membersDialog).getByText('@global-bot')).toBeTruthy()
    expect(within(membersDialog).getAllByText('全局').length).toBeGreaterThanOrEqual(1)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(b.view.queryByRole('dialog', { name: '成员' })).toBeNull())

    // 3. Channel Creation Modal: initial members picker displays (全局)
    const addChannelTrigger = b.view.getByRole('button', { name: '新建频道' })
    fireEvent.click(addChannelTrigger)

    const channelModal = await b.view.findByRole('dialog', { name: '新建频道' })
    const pickerTrigger = within(channelModal).getByRole('button', { name: '初始成员' })
    fireEvent.click(pickerTrigger)

    expect(await within(document.body).findByRole('menuitem', { name: /global-bot \(全局\)/ })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })

    // 4. Channel Editor Dialog: member list renders Global badge
    const editChannelBtn = b.view.getByRole('button', { name: 'engineering 的操作' })
    fireEvent.click(editChannelBtn)
    fireEvent.click(await b.view.findByRole('menuitem', { name: '编辑频道' }))

    const editChannelModal = await b.view.findByRole('dialog', { name: '编辑频道' })
    const globalEditRow = within(editChannelModal).getByText('@global-bot').closest('div')!
    expect(within(globalEditRow).getByText('全局')).toBeTruthy()

    await b.runtime.dispose()
  })

  it('allows editing an agent scope from workspace to global with dirty tracking', async () => {
    const mockMemberStatus: AgentTeamClientMemberStatus = {
      member: {
        memberId: 'member:test1' as any,
        sessionId: 'session:test1' as any,
        workspaceId: 'w1' as any,
        handle: 'analyzer',
        description: 'Code analyzer',
        presetId: 'team-member',
        state: 'enabled',
        isGlobal: false,
      },
      availability: 'active',
      presence: 'available',
    }

    const mockUpdate = vi.fn(async () => ({ ok: true as const, value: { receipt: {} as any, status: mockMemberStatus as any } }))
    const mockOnCommitted = vi.fn()
    const mockOnClose = vi.fn()
    const t = (key: string) => (zh as Record<string, string>)[key] ?? key

    const view = render(
      <AgentEditorDialog
        status={mockMemberStatus}
        updateMember={mockUpdate}
        loadModels={async () => ({ ok: true, value: { groups: [], failures: [] } })}
        onCommitted={mockOnCommitted}
        onClose={mockOnClose}
        t={t as any}
      />
    )

    // Verify initial state: workspace is checked, Save is disabled (not dirty)
    const saveBtn = view.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)

    const workspaceRadio = view.getByRole('radio', { name: /工作区 Agent/ }) as HTMLInputElement
    const globalRadio = view.getByRole('radio', { name: /全局 Agent/ }) as HTMLInputElement
    expect(workspaceRadio.checked).toBe(true)
    expect(globalRadio.checked).toBe(false)

    // Select Global scope -> form becomes dirty -> Save is enabled
    fireEvent.click(globalRadio)
    expect(globalRadio.checked).toBe(true)
    expect(saveBtn.disabled).toBe(false)

    // Submit form
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        memberId: 'member:test1',
        handle: 'analyzer',
        description: 'Code analyzer',
        isGlobal: true,
      }))
      expect(mockOnCommitted).toHaveBeenCalled()
      expect(mockOnClose).toHaveBeenCalled()
    })
  })

  it('disables demoting a global agent when canDemote is false with explanation notice and tooltip', async () => {
    const mockGlobalMemberStatus: AgentTeamClientMemberStatus = {
      member: {
        memberId: 'member:global-worker' as any,
        sessionId: 'session:gw' as any,
        workspaceId: 'w1' as any,
        handle: 'global-worker',
        description: 'Shared worker',
        presetId: 'team-member',
        state: 'enabled',
        isGlobal: true,
      },
      availability: 'active',
      presence: 'available',
    }

    const mockUpdate = vi.fn(async () => ({ ok: true as const, value: { receipt: {} as any, status: mockGlobalMemberStatus as any } }))
    const t = (key: string) => (zh as Record<string, string>)[key] ?? key

    const view = render(
      <AgentEditorDialog
        status={mockGlobalMemberStatus}
        updateMember={mockUpdate}
        loadModels={async () => ({ ok: true, value: { groups: [], failures: [] } })}
        canDemote={false}
        onCommitted={vi.fn()}
        onClose={vi.fn()}
        t={t as any}
      />
    )

    // Global radio is checked
    const globalRadio = view.getByRole('radio', { name: /全局 Agent/ }) as HTMLInputElement
    expect(globalRadio.checked).toBe(true)

    // Workspace radio is disabled because canDemote is false
    const workspaceRadio = view.getByRole('radio', { name: /工作区 Agent/ }) as HTMLInputElement
    expect(workspaceRadio.disabled).toBe(true)

    // Explanatory warning notice is displayed
    expect(view.getByText('该 Agent 已加入其他工作区的频道，无法更改为工作区作用域。请先从其他工作区频道中移除。')).toBeTruthy()

    // Dialog description displays Global Agent text
    expect(view.getByText('@global-worker · 全局 Agent')).toBeTruthy()
  })

  it('allows demoting a global agent when canDemote is true', async () => {
    const mockGlobalMemberStatus: AgentTeamClientMemberStatus = {
      member: {
        memberId: 'member:global-worker' as any,
        sessionId: 'session:gw' as any,
        workspaceId: 'w1' as any,
        handle: 'global-worker',
        description: 'Shared worker',
        presetId: 'team-member',
        state: 'enabled',
        isGlobal: true,
      },
      availability: 'active',
      presence: 'available',
    }

    const mockUpdate = vi.fn(async () => ({ ok: true as const, value: { receipt: {} as any, status: mockGlobalMemberStatus as any } }))
    const t = (key: string) => (zh as Record<string, string>)[key] ?? key

    const view = render(
      <AgentEditorDialog
        status={mockGlobalMemberStatus}
        updateMember={mockUpdate}
        loadModels={async () => ({ ok: true, value: { groups: [], failures: [] } })}
        canDemote={true}
        onCommitted={vi.fn()}
        onClose={vi.fn()}
        t={t as any}
      />
    )

    const workspaceRadio = view.getByRole('radio', { name: /工作区 Agent/ }) as HTMLInputElement
    expect(workspaceRadio.disabled).toBe(false)

    // Click Workspace Agent -> dirty -> Submit
    fireEvent.click(workspaceRadio)
    const saveBtn = view.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    fireEvent.click(saveBtn)

    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
        memberId: 'member:global-worker',
        isGlobal: false,
      }))
    })
  })

  it('displays Global badge in @mention suggestions in TeamComposer', async () => {
    const globalMember: AgentTeamClientMemberStatus = {
      member: {
        memberId: 'member:global-lead' as any,
        sessionId: 'session:gl' as any,
        workspaceId: 'w1' as any,
        handle: 'global-lead',
        description: 'Lead coordinator',
        presetId: 'team-member',
        state: 'enabled',
        isGlobal: true,
      },
      availability: 'active',
      presence: 'available',
    }
    const localMember: AgentTeamClientMemberStatus = {
      member: {
        memberId: 'member:local-dev' as any,
        sessionId: 'session:ld' as any,
        workspaceId: 'w1' as any,
        handle: 'local-dev',
        description: 'Local developer',
        presetId: 'team-member',
        state: 'enabled',
        isGlobal: false,
      },
      availability: 'active',
      presence: 'available',
    }

    const view = render(
      <ComposerTestHarness members={[globalMember, localMember]} />
    )

    const textarea = view.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '@glo' } })
    fireEvent.select(textarea, { target: { selectionStart: 4, selectionEnd: 4 } })

    // Autocomplete listbox opens with mention suggestions
    const listbox = await view.findByRole('listbox', { name: '提及成员建议' })
    expect(listbox).toBeTruthy()

    // Global option renders @global-lead with "全局" Pill
    const option = within(listbox).getByRole('option', { name: /global-lead/ })
    expect(within(option).getByText('全局')).toBeTruthy()
  })

  it('enforces localization parity between English and Chinese for all new keys', () => {
    const requiredKeys = [
      'agentScope',
      'workspaceAgent',
      'workspaceAgentDesc',
      'globalAgent',
      'globalAgentDesc',
      'globalBadge',
      'globalAgentsSection',
      'scopeDemoteDisabledTooltip',
      'scopeCannotDemoteNotice',
    ] as const

    for (const key of requiredKeys) {
      expect(zh[key]).toBeDefined()
      expect(typeof zh[key]).toBe('string')
      expect(zh[key].length).toBeGreaterThan(0)

      expect(en[key]).toBeDefined()
      expect(typeof en[key]).toBe('string')
      expect(en[key].length).toBeGreaterThan(0)
    }
  })
})
