import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

// /cut — drop the oldest N thousand tokens from the model context.
//   /cut 50     drop another 50k
//   /cut -50    put the last 50k back
//   /cut 0      restore everything
// Cuts stack, so running the same command twice takes twice as much. History is
// never deleted: the cut is applied to the request only.
const UNIT = 1_000
const LOG = "/tmp/opencode/cut.log"
const TOAST = "/tmp/opencode/cut.toast"
const CAP = 10_000_000
const DEFAULT = 200

type Msg = { role: string; content?: unknown[] }
type Applied = { at: number; before: number; after: number; dropped: number }

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

const weight = (m: Msg) => Math.ceil(JSON.stringify(m).length / 4)

// The TUI half watches this file and turns each new value into a toast. A
// server plugin has no direct access to the terminal UI.
const announce = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
  try {
    await mkdir(dirname(TOAST), { recursive: true })
    await writeFile(TOAST, `${Date.now()}|${variant}|${message}`)
  } catch {
    // A missing toast is not worth failing a command over.
  }
}

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
    // The last request seen per session, so /cut status can report the real
    // numbers instead of guessing from the stored transcript.
    const applied = new Map<string, Applied>()

    // Storage is the only source of truth: several plugin instances can serve
    // the same session, so an in-memory copy would go stale between them.
    const depth = async (sid: string) => {
      try {
        const stored = (await ctx.storage.get(`cut/${sid}`)) as { depth?: unknown } | undefined
        const value = stored?.depth
        return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
      } catch {
        return 0
      }
    }

    const set = async (sid: string, value: number) => {
      if (value <= 0) {
        await ctx.storage.remove(`cut/${sid}`)
        return
      }
      await ctx.storage.set(`cut/${sid}`, { depth: value, at: Date.now() })
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "cut",
        description: "Drop the oldest N thousand tokens (negative restores, 0 resets, default 200)",
        execute: async ({ sessionID, prompt }) => {
          const raw = String(prompt?.text ?? "").trim()
          note(`command ${sessionID} args=${JSON.stringify(raw)}`)

          if (raw === "status") {
            const value = await depth(sessionID)
            const last = applied.get(sessionID)
            if (last) {
              const cut = last.before - last.after
              note(
                `status ${sessionID} depth=${value} before=${last.before} cut=${cut} dropped≈${last.dropped} visible=${last.after}`,
              )
              announce(
                `Depth ${value / UNIT}k · last request cut ${cut} msgs (~${Math.round(last.dropped / 100) / 10}k tokens), ${last.after} msgs sent`,
              )
            } else {
              note(`status ${sessionID} depth=${value} last=none`)
              announce(`Depth ${value / UNIT}k · no request since the last change`)
            }
            return
          }

          const args = raw.toLowerCase()
          if (args !== "" && !/^-?\d+k?$/.test(args)) {
            note(`invalid ${sessionID} args=${JSON.stringify(raw)}`)
            announce("Use /cut 50, /cut -50, /cut 0 or /cut status", "warning")
            return
          }

          const number = args.replace(/k$/, "")
          const n = number === "" ? DEFAULT : Number(number)
          if (!Number.isSafeInteger(n) || Math.abs(n) > CAP / UNIT) {
            note(`range ${sessionID} n=${n}`)
            announce("That number is out of range", "warning")
            return
          }

          if (n === 0) {
            await set(sessionID, 0)
            applied.delete(sessionID)
            note(`reset ${sessionID}`)
            announce("Cut cleared · full history restored", "success")
            return
          }

          const value = Math.max(0, Math.min(CAP, (await depth(sessionID)) + n * UNIT))
          await set(sessionID, value)
          applied.delete(sessionID)
          note(`set ${sessionID} n=${n} depth=${value}`)
          announce(`Cut ${n > 0 ? "+" : ""}${n}k · depth ${value / UNIT}k`, "success")
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      const value = await depth(event.sessionID)
      if (!value) return

      const before = event.messages.length
      const { cut, dropped } = plan(event.messages as Msg[], value)
      if (cut <= 0) {
        note(`noop ${event.sessionID} depth=${value} msgs=${before}`)
        return
      }

      const from = (event.messages[cut] as Msg).role
      const prev = (event.messages[cut - 1] as Msg).role
      event.messages.splice(0, cut)
      applied.set(event.sessionID, { at: Date.now(), before, after: before - cut, dropped })
      note(
        `apply ${event.sessionID} depth=${value} dropped≈${dropped} msgs=${before}->${before - cut} cut=${cut} ${prev}->${from}`,
      )
    })
  },
})
