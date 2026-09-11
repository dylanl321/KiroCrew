/**
 * A pack's OWN cue: the sound an appearance pack ships with, played on the same
 * state-entry edge as a preset.
 *
 * It is a separate file from `useCrewAvatarState.test.tsx` because the pack path
 * is asynchronous — it reads the pack before it can know whether a cue exists —
 * so it needs real timers where that suite runs on fake ones.
 *
 * The rules worth pinning are the ones whose failure is LOUD: page load must be
 * silent, one edge must produce one cue however many places the crew is on
 * screen, the global Settings toggle must silence a pack exactly as it silences a
 * preset, and a preset the user chose must win over whatever the pack author
 * shipped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'

import dashboardReducer, { sseSlots } from '../store/dashboardSlice'
import type { ChatSlot } from '../types'
import { useCrewAvatarState, __resetCrewAvatarSoundForTests } from '../hooks/useCrewAvatarState'
import { invalidatePackDetail } from '../lib/appearancePacks/detailCache'
import type { AvatarSounds } from '../lib/crewAvatarState'
import { loadSoundSettings, playPreset } from '../hooks/useNotificationSound'

vi.mock('../hooks/useNotificationSound', async importOriginal => {
  const actual = await importOriginal<typeof import('../hooks/useNotificationSound')>()
  return {
    ...actual,
    playPreset: vi.fn(),
    loadSoundSettings: vi.fn(() => ({ enabled: true, volume: 0.5, perCategory: {} })),
  }
})

const detail = vi.fn()
vi.mock('../api/client', () => ({
  api: { appearances: { detail: (id: string) => detail(id) } },
}))

/** Every `new Audio(...)` this render makes, with the src it was pointed at. */
const audios: { src: string; volume: number; play: ReturnType<typeof vi.fn> }[] = []

/** What `play()` answers this test. Swapped to a rejection where the point is
 *  what happens when the browser refuses. */
let playResult: () => Promise<void> = () => Promise.resolve()

class FakeAudio {
  volume = 1
  play = vi.fn(() => playResult())
  constructor(public src: string) {
    audios.push(this as unknown as (typeof audios)[number])
  }
}

const SLOT = 'chat-7-1'
const slot = (over: Partial<ChatSlot> = {}): ChatSlot =>
  ({ key: SLOT, messages: 2, running: false, mode: 'member', agent: 'radar', ...over }) as ChatSlot

function Probe({ running, packId, sounds }: {
  running: boolean; packId?: string | null; sounds?: AvatarSounds
}) {
  const state = useCrewAvatarState({ slotKey: SLOT, agentName: 'radar', running, packId, sounds })
  return <span data-testid="state">{state}</span>
}

function mount(running: boolean, packId: string | null = 'aurora', sounds?: AvatarSounds) {
  const store = configureStore({ reducer: { dashboard: dashboardReducer } })
  store.dispatch(sseSlots([slot({ running })] as never))
  const view = render(
    <Provider store={store}>
      <Probe running={running} packId={packId} sounds={sounds} />
    </Provider>,
  )
  const rerender = (next: boolean) =>
    view.rerender(
      <Provider store={store}>
        <Probe running={next} packId={packId} sounds={sounds} />
      </Provider>,
    )
  return { ...view, rerender }
}

const originalAudio = globalThis.Audio

beforeEach(() => {
  audios.length = 0
  playResult = () => Promise.resolve()
  detail.mockReset()
  detail.mockResolvedValue({ animations: {}, sounds: { working: true, done: true } })
  vi.mocked(playPreset).mockClear()
  vi.mocked(loadSoundSettings).mockReturnValue({ enabled: true, volume: 0.5, perCategory: {} })
  __resetCrewAvatarSoundForTests()
  invalidatePackDetail()
  ;(globalThis as unknown as { Audio: unknown }).Audio = FakeAudio
})

afterEach(() => {
  ;(globalThis as unknown as { Audio: unknown }).Audio = originalAudio
})

describe('pack cues', () => {
  it('plays the pack cue when the crew enters working', async () => {
    const view = mount(false)
    expect(screen.getByTestId('state').textContent).toBe('idle')

    view.rerender(true)

    await waitFor(() => expect(audios).toHaveLength(1))
    expect(audios[0].src).toBe('/api/appearances/aurora/sound/working')
    // The volume the user set, not the element's default.
    expect(audios[0].volume).toBe(0.5)
    expect(audios[0].play).toHaveBeenCalled()
  })

  it('plays the done cue when a turn finishes', async () => {
    const view = mount(true)
    view.rerender(false)

    await waitFor(() => expect(audios).toHaveLength(1))
    expect(audios[0].src).toBe('/api/appearances/aurora/sound/done')
  })

  it('is silent on mount, even into an already-running crew', async () => {
    mount(true)
    expect(screen.getByTestId('state').textContent).toBe('working')
    // Give the async pack read every chance to land before asserting silence.
    await Promise.resolve()
    await Promise.resolve()
    expect(audios).toHaveLength(0)
    expect(detail).not.toHaveBeenCalled()
  })

  it('stays silent for a state the pack carries no cue for', async () => {
    detail.mockResolvedValue({ animations: {}, sounds: { done: true } })
    const view = mount(false)
    view.rerender(true)

    await waitFor(() => expect(detail).toHaveBeenCalled())
    expect(audios).toHaveLength(0)
  })

  it('obeys the global sound toggle', async () => {
    vi.mocked(loadSoundSettings).mockReturnValue({ enabled: false, volume: 0.5, perCategory: {} })
    const view = mount(false)
    view.rerender(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('working'))
    expect(audios).toHaveLength(0)
    // Not even READ: the toggle is checked before the pack, so a silenced
    // dashboard costs no request either.
    expect(detail).not.toHaveBeenCalled()
  })

  it('stays silent at zero volume', async () => {
    vi.mocked(loadSoundSettings).mockReturnValue({ enabled: true, volume: 0, perCategory: {} })
    const view = mount(false)
    view.rerender(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('working'))
    expect(audios).toHaveLength(0)
  })

  it('plays once for one edge, however many places the crew is on screen', async () => {
    const store = configureStore({ reducer: { dashboard: dashboardReducer } })
    store.dispatch(sseSlots([slot({ running: false })] as never))
    const tree = (running: boolean) => (
      <Provider store={store}>
        <Probe running={running} packId="aurora" />
        <Probe running={running} packId="aurora" />
      </Provider>
    )
    const view = render(tree(false))
    view.rerender(tree(true))

    await waitFor(() => expect(audios).toHaveLength(1))
    // A second flush would reveal a straggler: the debounce entry is claimed
    // before the asynchronous pack read, not after it.
    await Promise.resolve()
    await Promise.resolve()
    expect(audios).toHaveLength(1)
  })

  it('lets the record own preset win over the pack own cue', async () => {
    const view = mount(false, 'aurora', { working: 'chime' } as AvatarSounds)
    view.rerender(true)

    await waitFor(() => expect(playPreset).toHaveBeenCalledWith('chime', 0.5))
    expect(audios).toHaveLength(0)
    expect(detail).not.toHaveBeenCalled()
  })

  it('respects a record that silences that state explicitly', async () => {
    // `'none'` is a stored value, not an absence: it says DELIBERATELY SILENT, so
    // the pack's cue must not overrule the user turning that state off.
    const view = mount(false, 'aurora', { working: 'none' } as AvatarSounds)
    view.rerender(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('working'))
    expect(audios).toHaveLength(0)
    expect(playPreset).not.toHaveBeenCalled()
    expect(detail).not.toHaveBeenCalled()
  })

  it('still plays the pack cue for a state the record says nothing about', async () => {
    // The other half of the rule above: silencing `working` must not silence
    // `done` too, so the fallback is per state rather than per record.
    const view = mount(true, 'aurora', { working: 'none' } as AvatarSounds)
    view.rerender(false)

    await waitFor(() => expect(audios).toHaveLength(1))
    expect(audios[0].src).toBe('/api/appearances/aurora/sound/done')
  })

  it('stays silent for a crew wearing no pack', async () => {
    const view = mount(false, null)
    view.rerender(true)

    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('working'))
    expect(audios).toHaveLength(0)
    expect(detail).not.toHaveBeenCalled()
  })

  it('stays silent when the pack cannot be read', async () => {
    detail.mockRejectedValue(new Error('pack_not_found'))
    const view = mount(false)
    view.rerender(true)

    await waitFor(() => expect(detail).toHaveBeenCalled())
    expect(audios).toHaveLength(0)
  })

  it('leaves a diagnostic when the cue itself will not play', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    playResult = () => Promise.reject(new Error('NotAllowedError'))
    const view = mount(false)
    view.rerender(true)

    await waitFor(() => expect(warn).toHaveBeenCalledWith(
      '[appearance-pack] cue did not play',
      expect.objectContaining({ pack: 'aurora', state: 'working' }),
    ))
    warn.mockRestore()
  })
})
