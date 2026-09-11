/**
 * A crew's face when the crew wears an APPEARANCE PACK — art somebody else drew,
 * served per state from the crew appearance library.
 *
 * `CrewAvatar` composes the seeded ghost itself and draws an uploaded picture as
 * an `<img>`. A pack is neither: its art may be an SVG, a Lottie document or a
 * row of a sprite sheet, and the format is a property of the SLOT rather than of
 * the pack, so which player draws it can only be known after reading the pack.
 * That read is what this component owns, and it is why the pack tier is a
 * component rather than another `src` in `CrewAvatar`.
 *
 * Three tiers, one per format:
 *   svg     — an `<img>` pointed at the per-slot route, exactly as before.
 *   lottie  — `LottieRenderer`, looping.
 *   sprite  — `SpriteRenderer`, stepping the row this slot occupies.
 *
 * ANIMATION IS BOUNDED BY VISIBILITY. A roster draws one avatar per crew at
 * 18-38px, so a page can hold dozens; a Lottie timeline or a sprite loop per row
 * would spend real per-frame work on faces scrolled far out of view. Each avatar
 * therefore observes its own box and animates only while it intersects the
 * viewport — off screen it holds frame 0. The rule is visibility rather than a
 * size threshold on purpose: the dense roster's own avatars are 38px, so any
 * threshold low enough to animate the crew card would animate every row in the
 * list at once, which is the cost this bound exists to remove.
 *
 * A failed read reports through `onError` and renders nothing, so `CrewAvatar`
 * answers with the seeded ghost — the same thing a deleted pack already shows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { LottieRenderer } from './LottieRenderer'
import { SpriteRenderer } from './SpriteRenderer'
import { packSlotUrl } from '../../lib/appearancePacks/library'
import { resolveSlot, spriteRowFor, type PackDetail } from '../../lib/appearancePacks/detail'
import { loadPackDetail } from '../../lib/appearancePacks/detailCache'

/** Frames per second for a sheet that names none. The Companion's own gallery
 *  uses the same default, so a pack authored there steps at the rate it was
 *  drawn at. */
const DEFAULT_FPS = 8

/**
 * How long to wait before re-reading a pack whose first read failed, and how
 * many times.
 *
 * A read fails for two different reasons and only one of them is permanent: the
 * pack is gone (404), or the gateway was briefly unreachable. Reporting the first
 * failure as final made a blip during a roster render leave EVERY pack crew on
 * the seeded ghost until the tab was reloaded, because nothing re-reads a mounted
 * avatar. One retry separates the two without a refetch lifecycle: a real 404
 * fails twice and falls back, a blip recovers.
 */
const RETRY_DELAY_MS = 2000
const MAX_ATTEMPTS = 2

export interface PackAvatarProps {
  /** The pack id from the crew's `avatar` record — already validated by
   *  `packAvatarFrom`, and never the built-in `kiro-ghost` (whose art ships in
   *  this bundle and is composed locally). */
  id: string
  /** Which reaction to draw. Resolved through the pack's own fallback chain, so
   *  a pack that draws only `idle` still answers every state. */
  state: string
  /** Rendered edge length in px. The art fits this box. */
  size: number
  className?: string
  /** Fired when the pack cannot be read or draws nothing for any state, BEFORE
   *  the caller's fallback renders — so a blank face is never reported as saved
   *  fine. */
  onError?: () => void
}

export default function PackAvatar({ id, state, size, className = '', onError }: PackAvatarProps) {
  const [detail, setDetail] = useState<PackDetail | null>(null)
  const [failed, setFailed] = useState(false)
  /** Which read this is, 1-based. Bumped by a failed read to re-arm the effect. */
  const [attempt, setAttempt] = useState(1)
  // The box is mounted even while the art is not, so the observer has something
  // to watch from the first commit rather than only once the read lands.
  const boxRef = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)

  // A new pack starts the read over from attempt 1. Separate from the read effect
  // so that changing the id cannot be mistaken for a retry of the previous pack,
  // and declared BEFORE it so it runs first within the same commit.
  useEffect(() => {
    setDetail(null)
    setFailed(false)
    setAttempt(1)
  }, [id])

  // Keyed on the id and the attempt, not on `state`: `state` picks a slot out of
  // a pack already in hand, and the cache answers a second mount of the same
  // pack without a request.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    loadPackDetail(id).then(
      (loaded) => {
        if (!cancelled) setDetail(loaded)
      },
      () => {
        if (cancelled) return
        if (attempt >= MAX_ATTEMPTS) {
          setFailed(true)
          return
        }
        timer = setTimeout(() => setAttempt(attempt + 1), RETRY_DELAY_MS)
      },
    )
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [id, attempt])

  useEffect(() => {
    const node = boxRef.current
    // No IntersectionObserver (an old engine, a test env that removed it) means
    // no visibility signal, so animate: a still avatar everywhere is a worse
    // regression than an unbounded one on an engine nobody ships.
    if (!node || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      // Latest entry only. A burst of records for one target is a scroll, and
      // the last one is where it came to rest.
      const last = entries[entries.length - 1]
      if (last) setVisible(last.isIntersecting)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A pack that draws NOTHING for this state even after fallback is as broken as
  // one that could not be read — both leave the crew faceless, so both take the
  // ghost. Resolved before the error report below so one effect covers both.
  const slot = useMemo(() => (detail ? resolveSlot(detail, state) : null), [detail, state])
  const broken = failed || (detail !== null && slot === null)

  // Reported from an effect rather than during render: `onError` is a caller's
  // state write (`CrewAvatar` remembers the failure, the crew editor shows a
  // warning), and doing that in a render body updates another component
  // mid-render.
  useEffect(() => {
    if (broken) onError?.()
  }, [broken, onError])

  // Stable, because `LottieRenderer` takes it as an effect dependency: a fresh
  // identity per render would destroy and reload the animation every render.
  const reportFailed = useCallback(() => setFailed(true), [])

  const box = `shrink-0 overflow-hidden rounded-md border border-border bg-bg-elevated ${className}`

  if (broken) return null

  // Before the read lands there is nothing to draw and no way to know which
  // player will draw it, so the box holds its space rather than flashing a ghost
  // that the art then replaces.
  if (!detail || !slot) {
    return (
      <span
        ref={boxRef}
        aria-hidden="true"
        className={box}
        style={{ width: size, height: size, display: 'inline-block' }}
        data-testid="pack-avatar-pending"
      />
    )
  }

  const art = detail.animations[slot]

  return (
    <span
      ref={boxRef}
      aria-hidden="true"
      className={box}
      style={{ width: size, height: size, display: 'inline-block', lineHeight: 0 }}
      data-testid={`pack-avatar-${art.format}`}
      data-pack-slot={slot}
      data-pack-playing={visible ? 'true' : 'false'}
    >
      {art.format === 'lottie' ? (
        <LottieRenderer
          animationData={art.content}
          width={size}
          height={size}
          loop
          autoplay={visible}
          // Malformed art is a load failure like a missing file: the importer only
          // checks that a pack's `.json` is non-empty, so a clip this player
          // cannot parse reaches here and must fall back rather than draw nothing.
          onError={reportFailed}
        />
      ) : art.format === 'sprite' ? (
        <SpriteRenderer
          // The sheet as an IMAGE, from the slot route — which base64-decodes it
          // to `image/png`. The inlined `content` is base64 text, and a canvas
          // cannot draw text.
          src={packSlotUrl(id, slot)}
          frameWidth={detail.sprite?.frameWidth || size}
          frameHeight={detail.sprite?.frameHeight || size}
          fps={detail.sprite?.fps || DEFAULT_FPS}
          displaySize={size}
          row={spriteRowFor(detail, slot)}
          playing={visible}
        />
      ) : (
        <img
          // The per-slot route, not the inlined `content`: it carries the
          // inert-SVG content policy the detail route's JSON body does not, and
          // it is what the picker's thumbnails already request, so the browser
          // cache is shared with them.
          src={packSlotUrl(id, slot)}
          alt=""
          aria-hidden="true"
          width={size}
          height={size}
          // object-contain, not cover: a pack's art is drawn to its own frame and
          // cropping it would cut the character's head off. The picture tier
          // crops because the client squares an upload before sending it.
          style={{ width: size, height: size, objectFit: 'contain' }}
          onError={reportFailed}
        />
      )}
    </span>
  )
}
