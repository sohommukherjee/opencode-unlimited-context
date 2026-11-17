import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// /cut — drop the oldest N thousand tokens from the model context.
//   /cut 50     drop another 50k
//   /cut -50    put the last 50k back
//   /cut 0      restore everything
// Cuts stack, so running the same command twice takes twice as much. The
// conversation is never rewritten; the cut is applied to the request only.
const UNIT = 1_000
const LOG = "/tmp/opencode/cut.log"
const TOAST = "/tmp/opencode/cut.toast"
const CAP = 10_000_000
const DEFAULT = 200
const MARK = "[cut] "

type Msg = {
  id?: string
  role: string
  content?: unknown[]
  metadata?: Record<string, unknown>
}
type Last = { depth: number; before: number; after: number; dropped: number; at: number }
type Read = { ok: true; value: number } | { ok: false }
type Event = { sessionID: string; messages: unknown[] }

// Notices carry this flag in their stored metadata, which survives into the
// context messages. Matching text instead would delete a real user message that
// happened to begin with the same prefix.
const LEGACY = /^\[cut\] (?:Cut (?:[+-]?\d+k|cleared|depth)|Use \/cut|That number)/
const isNotice = (m: Msg) => {
  if (m.role !== "user") return false
  if (m.metadata?.cutNotice === true) return true
  // Notices written before the metadata flag existed.
  const first = Array.isArray(m.content) ? (m.content[0] as { type?: string; text?: string }) : undefined
  return first?.type === "text" && typeof first.text === "string" && LEGACY.test(first.text)
}

// Shared across plugin instances in one process: a request must be planned only
// once, and concurrent commands for one session must not lose an increment.
const SHARED = Symbol.for("opencode-unlimited-context.shared")
type Shared = { seen: WeakSet<object>; locks: Map<string, Promise<void>> }
const shared: Shared = ((globalThis as Record<symbol, unknown>)[SHARED] ??= {
  seen: new WeakSet<object>(),
  locks: new Map<string, Promise<void>>(),
}) as Shared

const serial = async <T>(sid: string, fn: () => Promise<T>): Promise<T> => {
  const previous = shared.locks.get(sid) ?? Promise.resolve()
  const task = previous.then(fn, fn)
  shared.locks.set(
    sid,
    task.then(
      () => undefined,
      () => undefined,
    ),
  )
  return task
}

const ready: { log: Promise<unknown> | undefined } = { log: undefined }

const note = async (line: string) => {
  try {
    ready.log ??= mkdir(dirname(LOG), { recursive: true })
    await ready.log
    await appendFile(LOG, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // Retry the directory on the next line; logging must never disturb a request.
    ready.log = undefined
  }
}

// Media bodies serialize as one key per byte, which would make a single image
// look larger than the whole session. Replace them before measuring.
const weight = (m: Msg) =>
  Math.ceil(JSON.stringify(m, (_key, value) => (value instanceof Uint8Array ? "[media]" : value)).length / 4)

// Keep only the turn being answered, for a depth past the end of the transcript.
const lastTurn = (messages: Msg[]): number => {
  for (let i = messages.length - 1; i > 0; i--) if (messages[i].role === "user") return i
  return 0
}

// How many leading messages to drop, and what they weigh. Take the largest
// prefix that still fits inside the depth, so a request for 329k with edges at
// 320k and 335k lands on 320k and never overshoots. A tool result cannot open a
// request, so pull the edge back onto the call that produced it.
const plan = (messages: Msg[], depth: number): { cut: number; dropped: number } => {
  let dropped = 0
  let cut = 0
  for (let i = 0; i < messages.length; i++) {
    const w = weight(messages[i])
    if (dropped + w > depth) break
    dropped += w
    cut = i + 1
  }

  const limit = lastTurn(messages)
  if (cut > limit) {
    cut = limit
    dropped = 0
    for (let i = 0; i < cut; i++) dropped += weight(messages[i])
  }

  while (cut > 0 && messages[cut]?.role === "tool") {
    cut -= 1
    dropped -= weight(messages[cut])
  }

  return { cut, dropped }
}

export default Plugin.define({
  id: "cut",

  async setup(ctx) {
    const read = async (sid: string): Promise<Read> => {
      try {
        const stored = (await ctx.storage.get(`cut/${sid}`)) as { depth?: unknown } | undefined
        const value = stored?.depth
        return {
          ok: true,
          value: typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0,
        }
      } catch {
        // A transient read failure must not be treated as "no cut": callers
        // abort instead of persisting a value derived from zero.
        return { ok: false }
      }
    }

    const write = async (sid: string, value: number) => {
      if (value <= 0) {
        await ctx.storage.remove(`cut/${sid}`)
        return
      }
      await ctx.storage.set(`cut/${sid}`, { depth: value, at: Date.now() })
    }

    const readLast = async (sid: string): Promise<Last | undefined> => {
      try {
        const value = (await ctx.storage.get(`cut/${sid}/last`)) as Partial<Last> | undefined
        if (!value || typeof value.at !== "number") return undefined
        return value as Last
      } catch {
        return undefined
      }
    }

    const writeLast = async (sid: string, last: Last) => {
      try {
        await ctx.storage.set(`cut/${sid}/last`, last)
      } catch (error) {
        note(`last ${sid} failed ${String(error)}`)
      }
    }

    // A server plugin cannot reach the terminal UI directly, so results go two
    // ways: a small file the TUI half turns into a toast, and a synthetic notice
    // in the session. The toast is written first so a slow session call cannot
    // delay the only immediate feedback.
    const say = async (sessionID: string, text: string) => {
      try {
        await mkdir(dirname(TOAST), { recursive: true })
        await writeFile(TOAST, `${Date.now()}|${sessionID}|info|${text}`)
      } catch (error) {
        note(`toast ${sessionID} failed ${String(error)}`)
      }
      try {
        await ctx.session.synthetic({
          sessionID,
          text: `${MARK}${text}`,
          // The timeline renders a synthetic message's description, not its
          // text, and drops it entirely when the description is empty.
          description: text,
          metadata: { cutNotice: true },
          resume: false,
        })
      } catch (error) {
        note(`synthetic ${sessionID} failed ${String(error)}`)
      }
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "cut",
        description: "Drop the oldest N thousand tokens (negative restores, 0 resets, default 200)",
        execute: async ({ sessionID, prompt }) => {
          const raw = String(prompt?.text ?? "").trim().toLowerCase()
          note(`command ${sessionID} args=${JSON.stringify(raw)}`)

          if (raw === "status") {
            const current = await read(sessionID)
            if (!current.ok) {
              await say(sessionID, "Could not read the cut depth · try again")
              return
            }
            const value = current.value
            const last = await readLast(sessionID)
            if (last && value > 0) {
              const cut = last.before - last.after
              note(
                `status ${sessionID} depth=${value} at=${last.depth} before=${last.before} cut=${cut} dropped≈${last.dropped} visible=${last.after}`,
              )
              await say(
                sessionID,
                `Cut depth ${value / UNIT}k · last request at depth ${last.depth / UNIT}k cut ${cut} msgs (~${Math.round(last.dropped / 100) / 10}k tokens), ${last.after} msgs sent`,
              )
            } else if (value > 0) {
              note(`status ${sessionID} depth=${value} last=none`)
              await say(sessionID, `Cut depth ${value / UNIT}k · armed, no request cut yet`)
            } else {
              note(`status ${sessionID} depth=0 last=none`)
              await say(sessionID, "Nothing is cut right now")
            }
            return
          }

          if (raw !== "" && !/^-?\d+k?$/.test(raw)) {
            note(`invalid ${sessionID} args=${JSON.stringify(raw)}`)
            await say(sessionID, "Use /cut 50, /cut -50, /cut 0 or /cut status")
            return
          }

          const number = raw.replace(/k$/, "")
          const n = number === "" ? DEFAULT : Number(number)
          if (!Number.isSafeInteger(n) || Math.abs(n) > CAP / UNIT) {
            note(`range ${sessionID} n=${n}`)
            await say(sessionID, "That number is out of range")
            return
          }

          await serial(sessionID, async () => {
            const current = await read(sessionID)
            if (!current.ok) {
              await say(sessionID, "Could not read the cut depth · try again")
              return
            }

            if (n === 0) {
              try {
                await write(sessionID, 0)
                await ctx.storage.remove(`cut/${sessionID}/last`)
              } catch (error) {
                note(`reset ${sessionID} failed ${String(error)}`)
                await say(sessionID, "Could not clear the cut depth · try again")
                return
              }
              note(`reset ${sessionID}`)
              await say(sessionID, "Cut cleared · full history restored")
              return
            }

            const value = Math.max(0, Math.min(CAP, current.value + n * UNIT))
            try {
              await write(sessionID, value)
            } catch (error) {
              note(`set ${sessionID} failed ${String(error)}`)
              await say(sessionID, "Could not save the cut depth · try again")
              return
            }
            note(`set ${sessionID} n=${n} depth=${value}`)
            await say(
              sessionID,
              `Cut ${n > 0 ? "+" : ""}${n}k · depth ${value / UNIT}k · applies on your next message`,
            )
          })
        },
      })
    })

    // Title requests only need the notices removed; the transcript itself is
    // not being sent. Context and compaction requests get the full treatment.
    const prepare = async (event: Event, cut: boolean) => {
      // Another instance may already have prepared this exact request.
      if (shared.seen.has(event.messages)) return
      shared.seen.add(event.messages)

      for (let i = event.messages.length - 1; i >= 0; i--) {
        if (isNotice(event.messages[i] as Msg)) event.messages.splice(i, 1)
      }

      if (!cut) return

      const current = await read(event.sessionID)
      if (!current.ok) {
        note(`read ${event.sessionID} failed`)
        return
      }
      if (!current.value) return

      const value = current.value
      const before = event.messages.length
      const { cut: count, dropped } = plan(event.messages as Msg[], value)
      if (count <= 0) {
        const record = { depth: value, before, after: before, dropped: 0, at: Date.now() }
        void writeLast(event.sessionID, record)
        note(`noop ${event.sessionID} depth=${value} msgs=${before}`)
        return
      }

      const from = (event.messages[count] as Msg).role
      const prev = (event.messages[count - 1] as Msg).role
      event.messages.splice(0, count)
      const record = { depth: value, before, after: before - count, dropped, at: Date.now() }
      void writeLast(event.sessionID, record)
      note(
        `apply ${event.sessionID} depth=${value} dropped≈${dropped} msgs=${before}->${before - count} cut=${count} ${prev}->${from}`,
      )
    }

    await ctx.session.hook("context", (event) => prepare(event as unknown as Event, true))
    await ctx.session.hook("compaction", (event) => prepare(event as unknown as Event, true))
    await ctx.session.hook("title", (event) => prepare(event as unknown as Event, false))
  },
})
