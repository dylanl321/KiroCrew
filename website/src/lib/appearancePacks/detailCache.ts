/**
 * One `GET /api/appearances/{id}` per pack per session.
 *
 * Module-level rather than per-component, and for the same reason `CrewAvatar`'s
 * ghost cache is: the SAME pack is commonly on screen many times over (a roster
 * row per crew wearing it, the open thread's header, the editor preview), and
 * the detail route inlines every file in the pack — so a per-component fetch
 * would pull the whole pack once per avatar.
 *
 * The IN-FLIGHT promise is cached too, not just the answer. Without it, N avatars
 * mounting in one commit each start their own request, which is the shape the
 * cache exists to prevent.
 *
 * `invalidatePackDetail` is the write side: an import can replace a pack's art
 * under the same id, and a delete can remove it, so the library tab drops the
 * entry rather than leaving every avatar drawing art the library no longer holds.
 */
import { api } from '../../api/client'
import { packDetailFrom, type PackDetail } from './detail'

const CACHE = new Map<string, PackDetail>()
const INFLIGHT = new Map<string, Promise<PackDetail>>()

/**
 * This pack's detail, fetched at most once.
 *
 * A FAILED read is not cached: the failure is usually the pack being mid-import
 * or the gateway briefly unreachable, and a permanent negative entry would leave
 * every avatar wearing that pack blank for the life of the tab. It rejects, and
 * the caller reports the failure.
 */
export function loadPackDetail(id: string): Promise<PackDetail> {
  const hit = CACHE.get(id)
  if (hit) return Promise.resolve(hit)
  const pending = INFLIGHT.get(id)
  if (pending) return pending
  // `Promise.resolve().then(...)` rather than calling straight out: every caller
  // handles a REJECTION, so a client that throws synchronously (an unreachable
  // route object) must arrive as one too rather than as an exception escaping
  // whichever effect happened to ask first.
  const request = Promise.resolve()
    .then(() => api.appearances.detail(id))
    .then((payload) => {
      const detail = packDetailFrom(payload)
      CACHE.set(id, detail)
      return detail
    })
    .finally(() => {
      INFLIGHT.delete(id)
    })
  INFLIGHT.set(id, request)
  return request
}

/** Forget one pack, or every pack when called with no id. The library tab calls
 *  it after an import or a delete — both change what an id resolves to. */
export function invalidatePackDetail(id?: string): void {
  if (id === undefined) {
    CACHE.clear()
    INFLIGHT.clear()
    return
  }
  CACHE.delete(id)
  INFLIGHT.delete(id)
}
