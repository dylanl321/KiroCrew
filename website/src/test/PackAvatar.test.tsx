/**
 * The pack tier's renderer: which player draws which format, which slot a state
 * resolves to, that a pack is read once however many avatars wear it, that a
 * broken pack reports rather than rendering blank, and that an avatar the user
 * cannot see holds still.
 *
 * The players themselves are stubbed. `LottieRenderer` loads through lottie-web
 * and `SpriteRenderer` decodes through `new Image()` + a canvas, neither of which
 * happens in this environment — what is under test here is the DISPATCH, so the
 * stubs report the props they were handed.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import PackAvatar from '../components/appearancePacks/PackAvatar'
import { invalidatePackDetail } from '../lib/appearancePacks/detailCache'

vi.mock('../components/appearancePacks/LottieRenderer', () => ({
  LottieRenderer: ({ animationData, autoplay, loop, onError }: {
    animationData: string; autoplay?: boolean; loop?: boolean; onError?: () => void
  }) => (
    <button
      type="button"
      aria-label="lottie stub"
      data-testid="lottie-stub"
      data-bytes={String(animationData.length)}
      data-autoplay={String(autoplay)}
      data-loop={String(loop)}
      onClick={() => onError?.()}
    />
  ),
}))

vi.mock('../components/appearancePacks/SpriteRenderer', () => ({
  SpriteRenderer: ({ src, row, playing, fps, frameWidth }: {
    src: string; row?: number; playing?: boolean; fps?: number; frameWidth?: number
  }) => (
    <div
      data-testid="sprite-stub"
      data-src={src}
      data-row={String(row)}
      data-playing={String(playing)}
      data-fps={String(fps)}
      data-frame-width={String(frameWidth)}
    />
  ),
}))

const detail = vi.fn()
vi.mock('../api/client', () => ({
  api: { appearances: { detail: (id: string) => detail(id) } },
}))

/** An IntersectionObserver whose callback this test fires by hand, so the
 *  off-screen path is reachable (the suite's default stub always intersects). */
class ManualObserver {
  static instances: ManualObserver[] = []
  private readonly cb: IntersectionObserverCallback
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb
    ManualObserver.instances.push(this)
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] { return [] }
  fire(isIntersecting: boolean) {
    this.cb(
      [{ isIntersecting } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const originalObserver = globalThis.IntersectionObserver

function useManualObserver() {
  ManualObserver.instances = []
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ManualObserver
  ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = ManualObserver
}

beforeEach(() => {
  invalidatePackDetail()
  detail.mockReset()
})

afterEach(() => {
  cleanup()
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalObserver
  ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = originalObserver
})

describe('PackAvatar format dispatch', () => {
  it('draws an svg slot as an <img> on the per-slot route', async () => {
    detail.mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    render(<PackAvatar id="aurora" state="idle" size={40} />)

    const box = await screen.findByTestId('pack-avatar-svg')
    const img = box.querySelector('img')
    expect(img?.getAttribute('src')).toBe('/api/appearances/aurora/slot/idle')
    // Contain, not cover: a pack's art is drawn to its own frame.
    expect(img?.style.objectFit).toBe('contain')
  })

  it('draws a lottie slot through LottieRenderer, looping', async () => {
    detail.mockResolvedValue({
      animations: { idle: { content: '{"v":"5.7.4"}', format: 'lottie' } },
    })
    render(<PackAvatar id="aurora" state="idle" size={40} />)

    await screen.findByTestId('pack-avatar-lottie')
    const stub = screen.getByTestId('lottie-stub')
    expect(stub.getAttribute('data-bytes')).toBe('13')
    expect(stub.getAttribute('data-loop')).toBe('true')
  })

  it('draws a sprite slot through SpriteRenderer on the row its slot is assigned', async () => {
    detail.mockResolvedValue({
      animations: {
        idle: { content: 'base64', format: 'sprite' },
        working: { content: 'base64', format: 'sprite' },
      },
      sprite: { frameWidth: 16, frameHeight: 16, fps: 4, rowAssignments: { idle: 0, working: 1 } },
    })
    render(<PackAvatar id="aurora" state="working" size={40} />)

    const box = await screen.findByTestId('pack-avatar-sprite')
    expect(box.getAttribute('data-pack-slot')).toBe('working')
    const stub = screen.getByTestId('sprite-stub')
    expect(stub.getAttribute('data-row')).toBe('1')
    expect(stub.getAttribute('data-fps')).toBe('4')
    expect(stub.getAttribute('data-frame-width')).toBe('16')
    // The sheet comes from the slot route, which base64-DECODES it; a canvas
    // cannot draw the inlined base64 text.
    expect(stub.getAttribute('data-src')).toBe('/api/appearances/aurora/slot/working')
  })

  it('falls back to row 0 when the sheet assigns this slot no row', async () => {
    detail.mockResolvedValue({
      animations: { idle: { content: 'base64', format: 'sprite' } },
      sprite: { frameWidth: 16, frameHeight: 16, fps: 8 },
    })
    render(<PackAvatar id="aurora" state="idle" size={40} />)

    await screen.findByTestId('pack-avatar-sprite')
    expect(screen.getByTestId('sprite-stub').getAttribute('data-row')).toBe('0')
  })
})

describe('PackAvatar slot fallback', () => {
  it('resolves working through the pack own chain when it draws only idle', async () => {
    detail.mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    render(<PackAvatar id="aurora" state="working" size={40} />)

    const box = await screen.findByTestId('pack-avatar-svg')
    expect(box.getAttribute('data-pack-slot')).toBe('idle')
    expect(box.querySelector('img')?.getAttribute('src')).toBe('/api/appearances/aurora/slot/idle')
  })

  it('prefers loading over idle for working, matching the server chain', async () => {
    detail.mockResolvedValue({
      animations: {
        idle: { content: '<svg/>', format: 'svg' },
        loading: { content: '{"v":1}', format: 'lottie' },
      },
    })
    render(<PackAvatar id="aurora" state="working" size={40} />)

    const box = await screen.findByTestId('pack-avatar-lottie')
    expect(box.getAttribute('data-pack-slot')).toBe('loading')
  })
})

describe('PackAvatar pack reads', () => {
  it('reads a pack once however many avatars wear it', async () => {
    detail.mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    render(
      <>
        <PackAvatar id="aurora" state="idle" size={40} />
        <PackAvatar id="aurora" state="working" size={22} />
        <PackAvatar id="aurora" state="done" size={18} />
      </>,
    )

    await waitFor(() => expect(screen.getAllByTestId('pack-avatar-svg')).toHaveLength(3))
    expect(detail).toHaveBeenCalledTimes(1)
  })

  it('re-reads after the library invalidates the pack', async () => {
    detail.mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    const first = render(<PackAvatar id="aurora" state="idle" size={40} />)
    await screen.findByTestId('pack-avatar-svg')
    first.unmount()

    invalidatePackDetail('aurora')
    render(<PackAvatar id="aurora" state="idle" size={40} />)
    await screen.findByTestId('pack-avatar-svg')
    expect(detail).toHaveBeenCalledTimes(2)
  })
})

describe('PackAvatar failure reporting', () => {
  it('reports onError and renders nothing when the pack cannot be read', async () => {
    vi.useFakeTimers()
    detail.mockRejectedValue(new Error('pack_not_found'))
    const onError = vi.fn()
    render(<PackAvatar id="gone" state="idle" size={40} onError={onError} />)

    // Past the one retry: a real 404 fails both reads.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(screen.queryByTestId('pack-avatar-svg')).toBeNull()
    expect(screen.queryByTestId('pack-avatar-pending')).toBeNull()
    vi.useRealTimers()
  })

  it('reports onError when the pack draws nothing for any state', async () => {
    // A pack whose only art is a random clip: `done` resolves to done|idle, and
    // it carries neither, so there is no frame to draw.
    detail.mockResolvedValue({ animations: { walking: { content: '<svg/>', format: 'svg' } } })
    const onError = vi.fn()
    render(<PackAvatar id="aurora" state="done" size={40} onError={onError} />)

    await waitFor(() => expect(onError).toHaveBeenCalled())
  })

  it('reports onError when a lottie clip cannot be parsed', async () => {
    // Malformed art is a load failure like a missing file: the importer only
    // checks that a pack's `.json` is non-empty, so an unparseable clip gets
    // here and must fall back rather than leave an empty box.
    detail.mockResolvedValue({ animations: { idle: { content: '{bad', format: 'lottie' } } })
    const onError = vi.fn()
    render(<PackAvatar id="aurora" state="idle" size={40} onError={onError} />)

    const stub = await screen.findByTestId('lottie-stub')
    act(() => stub.click())
    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(screen.queryByTestId('pack-avatar-lottie')).toBeNull()
  })

  it('re-reads once before giving up, so a blip is not a permanent ghost', async () => {
    // Nothing re-reads a mounted avatar, so reporting the FIRST failure as final
    // left every pack crew on the seeded ghost until the tab was reloaded.
    vi.useFakeTimers()
    detail
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    const onError = vi.fn()
    render(<PackAvatar id="aurora" state="idle" size={40} onError={onError} />)

    await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(1))
    expect(onError).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await vi.waitFor(() => expect(screen.getByTestId('pack-avatar-svg')).toBeTruthy())
    expect(detail).toHaveBeenCalledTimes(2)
    expect(onError).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('gives up after the retry, so a deleted pack still falls back', async () => {
    vi.useFakeTimers()
    detail.mockRejectedValue(new Error('pack_not_found'))
    const onError = vi.fn()
    render(<PackAvatar id="gone" state="idle" size={40} onError={onError} />)

    await vi.waitFor(() => expect(detail).toHaveBeenCalledTimes(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await vi.waitFor(() => expect(onError).toHaveBeenCalled())
    expect(detail).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('reports onError when the served image itself fails to load', async () => {
    detail.mockResolvedValue({ animations: { idle: { content: '<svg/>', format: 'svg' } } })
    const onError = vi.fn()
    render(<PackAvatar id="aurora" state="idle" size={40} onError={onError} />)

    const img = (await screen.findByTestId('pack-avatar-svg')).querySelector('img')!
    img.dispatchEvent(new Event('error'))
    await waitFor(() => expect(onError).toHaveBeenCalled())
  })
})

describe('PackAvatar animation is bounded by visibility', () => {
  it('holds a lottie avatar on its first frame while it is off screen', async () => {
    useManualObserver()
    detail.mockResolvedValue({
      animations: { idle: { content: '{"v":1}', format: 'lottie' } },
    })
    render(<PackAvatar id="aurora" state="idle" size={38} />)

    // No observer callback has fired, so nothing is known to be visible yet.
    const box = await screen.findByTestId('pack-avatar-lottie')
    expect(box.getAttribute('data-pack-playing')).toBe('false')
    expect(screen.getByTestId('lottie-stub').getAttribute('data-autoplay')).toBe('false')
  })

  it('plays once the avatar scrolls into view, and stops when it leaves', async () => {
    useManualObserver()
    detail.mockResolvedValue({
      animations: { idle: { content: 'base64', format: 'sprite' } },
      sprite: { frameWidth: 16, frameHeight: 16, fps: 4 },
    })
    render(<PackAvatar id="aurora" state="idle" size={38} />)
    await screen.findByTestId('pack-avatar-sprite')

    const observer = ManualObserver.instances.at(-1)!
    observer.fire(true)
    await waitFor(() =>
      expect(screen.getByTestId('sprite-stub').getAttribute('data-playing')).toBe('true'),
    )

    observer.fire(false)
    await waitFor(() =>
      expect(screen.getByTestId('sprite-stub').getAttribute('data-playing')).toBe('false'),
    )
  })

  it('animates where the engine has no IntersectionObserver at all', async () => {
    ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined
    ;(window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = undefined
    detail.mockResolvedValue({
      animations: { idle: { content: '{"v":1}', format: 'lottie' } },
    })
    render(<PackAvatar id="aurora" state="idle" size={18} />)

    const box = await screen.findByTestId('pack-avatar-lottie')
    expect(box.getAttribute('data-pack-playing')).toBe('true')
  })
})
