# One big side: the bed while one sleeper is away

Status: built 2026-11-05 in f2cbe47c (`src/fork/oneSide.ts`,
`src/fork/smart/oneSideNight.ts`).
Replaced the "following" design in `src/fork/smart/following.ts` (installed
as of afe71509, now deleted).

This document is the reference for building and reviewing the change. If code
and this document disagree, one of them is wrong: settle which before merging.

## 1. The goal, in plain words

While one sleeper is away (or the bed is set up for one), and the away half is
set to "Matches the other side", **the bed is one side, and it belongs to the
sleeper at home.** Both halves of the cover always have the same temperature
and the same power. Anything done to either half is done to the bed. Anyone
detected on either half is the sleeper at home.

The hardware cannot do this by itself: the Pod has two thermal halves, each
with its own temperature, its own 8-hour firmware timer and its own buttons,
and the firmware applies a button press to the pressed half only. So the
software keeps the two halves identical.

## 2. Why the current design is being replaced

The current design treats the away half as a second side that copies the home
side: a copy of her Smart start session, copies of her holds that outlast hers
by 60 seconds so Smooth return steps can cross over, a "dismissed" state for a
half someone turned off, and a carry step after each redirected press. Every
copy is a second piece of state that has to be kept in step with the first,
and almost every bug found in the two reviews of 11-05 was a copy falling out
of step (a lock race, a mark mismatch, a Smooth return gap, quick presses
counted twice).

The new design has **no copies**. The away half has no temperature plan of its
own while the bed is one side: whenever sleepypod works out what the away half
should do, it uses the home side's plan. One plan, read twice, cannot fall out
of step.

## 3. The end state

### 3.1 Rules (each must hold; each gets a test)

Terms: **home side** (H) is the side of the sleeper at home. **Away half** (A)
is the other half while the bed is one side. **One side** means:
`scheduleSourceSide(A) === H` (one sleeper home, `unusedZoneMode` 'follow';
also a bed set up for one with 'follow') **and** the fork service is running
and not disabled. In every other state, nothing in this document applies and
each half is governed exactly as today.

1. **One plan.** A's temperature target, hold and hold end are H's: the same
   hold, the same Smart start or run-once session, the same weekly schedule,
   the same alarm warm-ups, the same surface offset. A has no hold, session or
   curve of its own while one side lasts.
2. **One temperature.** Within about a second of any change sleepypod makes to
   H's target, A has the same target. With no plan at all (H powered on by
   hand, outside any schedule), A has H's actual temperature. A change the
   firmware makes to A alone is undone once it has lasted 6 seconds, except
   during a press wait on A, when it is the press being measured. (Changes the
   firmware makes are seen only at its next status report, every 1 to 5
   seconds.)
3. **One power.** Within about a second of sleepypod changing H's power (one
   firmware status report, for a change the firmware makes), A is on exactly
   when H is on. A is
   turned on only while H is on and A's own pump guard allows it. A is turned
   off whenever H is off or blocked.
4. **One timer.** Every time H's half is written to the hardware (which
   restarts its 8-hour firmware timer), A's half is written too, so A's timer
   never runs out while H's is still running.
5. **Every control on A acts on H.** App and web temperature, power and
   "resume schedule"; HomeKit; cover taps; cover buttons. Turning either half
   off turns the bed off. Turning either half on turns the bed on. The one
   exception is the pump guard's own handling of A (rule 9).
6. **Plans come only from H.** Schedules, run-once sessions and Smart start
   belong to sleepers, not halves. The away sleeper's weekly schedules and
   settings are set aside, unchanged, for as long as one side lasts. A
   run-once session or hold still running on A when one side starts is ended:
   it was for a night the away sleeper is not here. No new one can start on A.
7. **One presence.** Smart start, Smart noise and the press rules see one
   presence for the bed: in when either half is in, empty when both are, and
   "making sure of a return" when either half shows a body. An entry on either
   half is the home sleeper's entry.
8. **One sleeper's record.** A press on either half is logged as the home
   sleeper's press (with the half it came from), so morning suggestions count
   it. Vitals and sleep records are already filed under H by upstream's Python
   modules; nothing changes there.
9. **Safety is per half.** A's pump stall guard still blocks A. A guard trip on
   A never turns H off. Nothing powers a half on before the firmware has
   reported in since start.
10. **Leaving one side is clean.** When one side ends, each half is governed by
    its own sleeper's settings again at once, with no leftover hold, session,
    hardware deadline or copy. A returning sleeper already lying on their half
    is treated as having just got into bed. A half whose sleeper has no Smart
    start acting is left powered as upstream leaves it (upstream's own return
    job deliberately turns the returning side on).
11. **Fails back to stock.** If the fork service stops or disables itself,
    one side ends (rule 10) and upstream's own mirror (weekly schedule only)
    takes over, as it would without the fork.

### 3.2 What disappears

- Session copies, hold copies, `HOLD_OVERLAP_MS`, `carryHomeHold`,
  `carriesHomeHold`, the "dismissed" state and its Tonight wording.
- The `followSmartStart` pod setting and its toggle. With one side there is
  nothing for A to follow separately: Smart start drives H, and A is H.
- `following.ts` (about 360 lines) is deleted. Its job splits between
  `oneSide.ts` (the core: `bedOwnerOf`, the wrapper, A's step, the redirect)
  and a new `src/fork/smart/oneSideNight.ts` (the fork's part: start and end
  steps, `FollowView` for the cards, the release when the service disables
  itself). `smartSourceOf`, `smartStartFor`, `bedState`, `followerOf`,
  `pointsFromNow`, `FollowResult` and `syncFollowing` go with it.
  `bedPresenceOf` does not go: it moves to the presence collector, unchanged
  (4.5).

### 3.3 What stays because the hardware is two halves

- **Button presses** still need redirecting: the firmware moves A's level
  before any code sees the press. The redirect becomes "step H by the amount
  the firmware moved A, then rewrite A from the plan".
- **Power and timers** still need syncing per half (rules 3 and 4), because
  sleepypod's controller never powers an off half on by itself, and each half
  has its own firmware timer.
- **Presence** is still detected per half; only the view is merged.

### 3.4 Easy to merge from upstream, easy to offer upstream

Two futures must stay cheap: merging each upstream release into `pod5`, and
someday offering this to upstream. This shapes the build, not the behaviour.

**What one big side is, in upstream's terms.** Upstream already has the idea:
"Matches the other side" (`unusedZoneMode` 'follow') makes the empty half
follow the sleeper's weekly schedule and scheduled power. It stops there. A
hold, a run-once session or a dial change on the sleeper's half does not reach
the empty half, and controls on the empty half act on it alone. One big side
is that same mode finished: the empty half follows the sleeper's whole plan,
and its controls act on the sleeper's. Built that way, it uses upstream's own
test for which half leads (`scheduleSourceSide`), and an upstream version
would be the same idea in upstream's code.

**Merging.** The risk is not conflicts: each stock-file edit is one line,
placed next to the fork line already in that function, so a conflict is small
and obvious. The risk is a new control path in an upstream release that
changes a half's temperature or power without passing through `bedOwnerOf`.
Nothing conflicts, and it quietly acts on A alone. The design already limits
the harm:

- power or a hardware write on A alone is undone by A's step within a second
  (rules 2 and 3);
- a hold written on A throws, so the control fails loudly instead of acting on
  half the bed (4.2).

To catch a new path at merge time rather than in bed, one test (8, item 11)
counts, per stock file, the calls that can write a half: calls into the
temperature controller and the hardware client's `setTemperature`/`setPower`.
A merge that changes any count fails the test until someone looks at the new
call and updates the count. The reasons each existing path is redirected or
left alone live in section 6 of this document, not in the test.

**Offering upstream.** Keep the two parts apart in the code:

- **The follow core**, in `src/fork/oneSide.ts`: `bedOwnerOf`, the dependency
  wrapper (4.2), A's step (4.3) and the side redirect the stock entry points
  call (4.4). It reads stock tables and the fork's runtime flag (rule 11), and
  asks the press code whether a press wait is open on A. This is the part
  upstream could take.
- **The fork's part**: Smart start, merged presence, cover button presses
  (fork code today), the start and end steps (section 5) and the Tonight
  wording. These stay in their own fork files.

The split is by file only; no test polices the core's imports (it needs the
press-wait question, which is fork code).

Upstream would still want more than the core: it would have to handle the
known gaps this Pod has switched off (bed-exit auto-off, auto-on, the maximum
on-time cap and autopilot; section 6), and upstream would put it inline rather
than behind hooks. So an offer means a port, not a copy of the commit. The
plan keeps that port small; it does not do it now.

**If upstream builds it first**, drop the fork's core and keep only the fork's
part on top of theirs. The section 6 table is the checklist for comparing.

## 4. How it is built

### 4.1 One question, asked everywhere: `bedOwnerOf(side)`

New file `src/fork/oneSide.ts`. `bedOwnerOf(side)` returns H for the away
half while one side lasts, and the side itself otherwise. It reads the bed
configuration (the same two tables `readBaseline` already reads) and the fork
runtime. It must be cheap and synchronous: the controller calls it several
times per status read, on the 1 Hz broadcast, every `getStatus` and every
tick. So it reads through its own cached `sqlite.prepare` statements (the
ORM costs about 16 ms per read on the Pod, a prepared statement well under
1 ms; see the note in `instance.ts`). No time-based cache: a settings change
must count at once.

"The fork service is running" means `runtime.running`, not `disabled`, and a
fresh heartbeat (`lastBeat` within `ownershipStaleMs`, as `smartOwnsSide`
checks, without its sensor and detection terms). A service that hangs then
hands the bed back to stock within minutes.

### 4.2 The controller sees one plan (rules 1, 2, 9)

`src/temperature/instance.ts` (upstream file, already has fork hooks). The
controller itself (`controller.ts`) is not changed. One line wraps the
dependencies passed to the controller: `new TemperatureController(withOneSide({ ... }))`.
`withOneSide` (in `oneSide.ts`) resolves the owner before calling the stock
function, so nothing inside `readBaseline` changes, and a merge that edits
`readBaseline` cannot conflict with ours:

| Dependency | For A while one side lasts |
|---|---|
| `readHold(A)` | H's hold row |
| `writeHold(A, null)` | ignored, so turning A off or a hold expiring on A never ends H's hold |
| `writeHold(A, hold)` | **throws**. Every control on A is redirected to H before it reaches the controller (4.4), so a hold written on A means a path was missed. Failing loudly finds it; writing H's row from A's lock would hide it, and a failed write on A would then leave a hold on H that the caller was told had failed. |
| `readBaseline(A)` | `readBaseline(H)`: H's schedule rows (already so today via `scheduleSourceSide`), **H's run-once sessions** (today: A's own), H's alarm warm-ups, **H's surface offset** (today: A's) |
| `defaultHoldMs(A)` | H's |
| `apply(H, …)` | the stock write, then marks A as owed a write (4.3) |

Consequence: `controller.status(A)` reports H's target, source and hold end,
with A's own power and guard state.

Autopilot requests are kept per half in the controller's memory and are not
aliased. Upstream automations are not used on this Pod (0 rows). Recorded as a
known gap, not handled.

### 4.3 Power, temperature and timer follow H (rules 2, 3, 4, 9)

**A has one writer: its step in upstream's own 1-second tick.** Upstream's
temperature service already reconciles each half every second
(`startTemperatureController` in `instance.ts`). One line there sends each
half to `tickHalf(side, isCurrent)` in `oneSide.ts` instead of straight to
`reconcile`. For every half that is not A while one side lasts, `tickHalf` is
exactly `reconcile(side, false, isCurrent)`. For A it is A's step, below.
This way A's step inherits the tick's firmware-synced gate, its per-half
no-overlap guard and its drain at shutdown, and there is no second loop that
could write A behind the step's back. (An earlier draft had a separate fork
loop. Upstream's tick would still have reconciled A as well, rewriting A
during a press wait and spoiling the press measurement, and the fork loop
was not drained at shutdown.)

**A's step**, under A's lock, every second while one side lasts:

1. A is guard-blocked: do nothing. The pump guard owns A.
2. H is off or blocked: if A is on, by the controller's state or by the
   firmware's report (a power-off that failed), `powerOffLocked(A)`. Done.
3. A press wait is open on A: do nothing, so the firmware's move on A is still
   there to measure when the press settles (4.4).
4. "A's due temperature" is `status(A).targetTemperature` (H's plan). With
   no plan at all (H powered on by hand without a temperature, outside any
   schedule, or upstream's always-on), it is H's reported target
   (`device_state.target_temperature` of H).
5. `powerOnLocked(A, H's reported target, isCurrent)` when any of these holds:
   - A is off (`status(A).blocked === 'off'`, which includes A's own firmware
     timer having run out);
   - A is owed a write (below);
   - A's reported target (`device_state.target_temperature`) has been more
     than 1 °F from the due temperature for 6 seconds. This undoes a firmware
     move on A that no code turned into a hold (a tap with no gesture set, for
     example). One firmware step is 2.75 °F; within 1 °F is rounding between
     °F and the firmware's levels, which a level-against-level comparison
     would chase forever for a due temperature that is not a whole number.
     The 6 seconds matter because the firmware status poll and the press
     stream are separate: the moved level can show before the press that
     caused it, and correcting at once would erase the press before it is
     measured. The firmware sync skips 5 seconds after each write
     (`deviceStateSync.ts`), and `apply` writes the new target to
     `device_state` itself, so a write does not read back as a difference.
   Then clear the owed mark and the drift clock.
6. Otherwise `reconcileLocked(A, false, isCurrent)`, which writes H's target to
   A when it changed, as upstream's tick always did.

`powerOnLocked` both turns a half on and rewrites one that is on, at the
plan's target or, with no plan, at the fallback given, and makes no hold. So
one call covers every case, including the no-plan case where the controller
would otherwise use its 75 °F default or A's own old temperature.

The step only ever changes A, never H, so it cannot loop. It takes only A's
lock (upstream's tick already runs each half separately), so it cannot
deadlock with the scheduler, which takes left then right.

Timer (rule 4): the `apply` wrapper (4.2) marks A as owed a write after every
hardware write to H. A's step then rewrites A, restarting A's firmware timer
even when its temperature did not change. This covers Smart start's 6-hour
timer refresh and upstream's always-on keepalive (which writes H with no plan,
where a plain `invalidate` would produce no write). During a press wait on A
the mark simply waits, because step 3 comes first.

The pump guard's own trip, recovery and probe writes bypass `apply`. They only
happen while H is blocked, when A is off anyway.

**A's step is A's only source of power.** Upstream's scheduler would also
power A on and off with H (`drivenSides` returns both halves), but it checks
each half's own run-once session: at the weekly off time, H is skipped
because Smart start's session is running, while A is turned off, and the step
turns it straight back on. So one upstream line in `jobManager.ts`
`drivenSides` returns only the home side while the fork reports one side.
`syncMirroredSide` and `applyBedConfiguration` copy H's power as it is and
are left alone.

Why not write A's hardware directly inside H's `apply`? It would be instant,
but it would write A without A's lock, so a pump guard trip on A could be
undone by a write that had already checked the guard. A's step takes A's
lock, as every other writer does.

### 4.4 Controls on A act on H (rule 5)

Resolve the side at the entry point, before the side lock is taken, so the
lock held is H's. Each entry point in the table calls `controlSideOf(side)` in
`oneSide.ts`: `bedOwnerOf`, except for a half the pump guard is blocking
(below).

| Entry point | File (upstream) | Lines |
|---|---|---|
| App/web temperature | `src/server/routers/device.ts` `setTemperature` | 1 (also keys the dial-drag debounce by H, so drags on both halves merge) |
| App/web power | same, `setPower` | 1 |
| Resume schedule | same, `resumeTemperature` | 1 |
| HomeKit temperature and power | `src/homekit/accessories/sideController.ts` | 3 |
| Cover taps | `src/hardware/gestureActionHandler.ts` | 2: the temperature and power tap actions only. A ringing alarm and the alarm tap action stay on the tapped half, because the firmware stops only the tapped half's alarm, and redirecting would record H's alarm as ended while it rings. |
| Cover buttons | `src/fork/holds.ts` `settlePress` | fork code |

`markPersonPower` then records H, so Smart start sees a person turning the bed
on or off.

**The pump guard's own flows are never redirected.** The pump-alert router
parks a faulty half with `device.setPower({ side, powered: false })`
(`pumpAlerts.ts`). Redirected, that would park H and leave A running, and the
loop would then turn the whole bed off over a fault on A. So `setPower` and
`setTemperature` do not redirect a half the pump guard is blocking. A test
covers the park path.

Run-once start on A is **refused** while one side lasts, with the same message
as `runCommand(A)`: sessions are plans (rule 6), and a session started on A
would power A on from the router and later turn it off at its wake time, with
A's step undoing both. Run-once cancel on A is allowed, so the transition code
can cancel the away sleeper's own session.

The cover button redirect (`holds.ts`):

- A off (so the bed is off), and A not guard-blocked: the press goes to
  `noteSmartPress(H)`, as today. A guard-blocked A ignores presses.
- A on: at settle, step = A's reported target after the firmware's move
  (level 0 counts as 83 °F, as today) minus the last temperature sleepypod
  wrote to A (kept by the `apply` wrapper). Measuring from the last write,
  not from the bed's plan, means a change to the bed during the 10-second
  wait is never counted as part of the press: A's step leaves A alone during
  the wait (4.3), and if any other path writes A anyway (a forced keepalive,
  a settings change), that write erases the firmware's move and moves the
  base with it, so the press reads as no step instead of as the bed's change.
  Before the first write since the server started, the base is the bed's
  planned target recorded at the burst's first press. The step is read
  before any wait for a lock. With no plan on H, the hold is based on H's
  reported target.
- If H is off, turned off by sleepypod, or blocked when the press settles, the
  press is dropped (A follows H off within a second). Otherwise H takes a hold
  at H's current target plus the step, clamped as today, for the hold length
  the settings give. A is then owed a write, so it is rewritten from the plan
  even if the bed target did not change (for example when H is already at its
  warmest).
- No carry step, no dismissed check. The press is logged once, under H, with
  the half it came from.
- While one side lasts, a press on **either** half always becomes a hold on H.
  With "Hold after adjustment" set to Off, today a press on a side leaves the
  firmware's change standing with no hold; on a bed that is one side that
  change would reach only the pressed half. So the hold lasts until the
  curve's next change (`defaultHoldMs(H)`), which is what Off means for app
  changes already. (This Pod uses 60 minutes, so this is for completeness.)
- Guard checks in the redirected entry points run after the side is
  resolved, so they check H.

`stepSmoothReturn(A)` does nothing while one side lasts: H's own Smooth return
steps the one hold, and A follows by rule 2. This replaces `carriesHomeHold`.

### 4.5 One presence (rule 7)

`presenceOf(side)` keeps its meaning: one half's own reading. Its callers
(Smart noise's whole-bed checks and its "rolled across" rule, the runner's
other-side check, morning suggestions, surface range, the app's presence
line) all want that and are left alone.

`bedPresenceOf(side)` moves from `following.ts` into
`src/fork/presence/collector.ts`, unchanged in logic: for H while one side
lasts it merges H's and A's readings; for any other side it is
`presenceOf(side)`. It finds A with `bedOwnerOf`. Its three callers (the Smart
start runner, `noteSmartPress`, Smart noise's start rule) only change their
import. The runner's `takeEntry(H)` also takes an entry on A, with "moved
across" cleared, as today.

The end of one side (section 5) uses `presenceOf(A)` to check whether the
returning sleeper is lying on their half, and a new `noteEntry(side, at)` in
the collector to record an entry for them.

Decision: presence merges only while one side lasts (zone mode 'follow'), as
today. Upstream's Python merges vitals whenever one sleeper is home, whatever
the zone mode. Extending the merge to 'off' (her rolling onto the unheated
half would otherwise read as getting up) is a reasonable later step, kept out
of this change to keep it about one side. 'independent' should never merge:
the other half may have a guest.

### 4.6 Smart start and the service

- `runtime.smartFor(side)` is `getSideSettings(bedOwnerOf(side)).smartStart`.
  `smartSourceOf`, `smartStartFor` and the fork's `bedState` go;
  `bedOwnerOf` replaces them (noise's `activeSleeperSides(bedState())` reads
  the bed configuration through a small helper in `oneSide.ts`).
- The Smart start tick: first the start and end steps for each half
  (section 5), then `tickSide` for each half that owns itself. A's run is set
  aside when one side starts (as today).
- `runCommand(A)` keeps refusing, with the message "This half is part of
  {H}'s bed while its sleeper is away, so it has no curve or Smart start of
  its own." ("while the bed is set up for one" when nobody is away). A
  refused run-once start adds "Start it on {H}'s side."
- Surface range: `stepSurface(A)` does nothing while one side lasts. `stepSurface(H)`
  reads the surface of the half where `presenceOf` shows the sleeper (H's half
  if both or neither) and uses `bedPresenceOf(H)` for in or out. The offset
  reaches A through rule 1. Surface range is off on this Pod; this keeps it
  correct if it is turned on.
- Power resume after a power cut: skips A; A follows H by rule 3.

### 4.7 The app

- Fork overview: `following` becomes `{ leader, why }` (no `dismissed`).
- Tonight page for A: "The whole bed is {H}'s while {A} is away: both halves
  run {H}'s curve and Smart start, and buttons on either half change both."
  No Smart start controls for A.
- Sides card line (`SwitchCard.tsx`) and Away card wording to match;
  `tonightLogic.ts` takes the slimmer `FollowView` type; the demo handler
  keeps `following: null`.
- Remove the "Empty side follows Smart start" toggle and the `followSmartStart`
  setting (`settingsSchema.ts`, `ForkSettings.tsx`, the `followsSmartStart`
  prop in `AwayCard.tsx` and its test). The private setup script must stop
  sending it. A saved `followSmartStart` in `fork.db` must not break loading
  the settings (check how the schema treats unknown keys).
- Stock `SideCard.tsx` keeps saying "Following {H}'s schedule" for A. It
  understates the new behaviour, but it is a stock file, so it is left alone
  on purpose.
- iPhone app: no change needed. Its temperature and power controls on A reach
  the server, which redirects them. Its curve view on A shows no run-once
  session (A has none of its own) and cancelling one on A does nothing to H's;
  accepted, since starting one on A is refused anyway.

## 5. Starting and ending one side

Detected on the 30-second Smart start tick by comparing `bedOwnerOf` with a
saved mark (`one-side:{A}` = H).

**Start** (mark missing, A owned by H):
1. Cancel A's own active run-once session, if any, through the normal
   `runOnce.cancel({ side: A })` (not redirected).
2. Delete A's own hold row (the controller can no longer see or clear it) and
   clear A's hardware deadline (`writeHardwareDeadline(A, null)`). A deadline
   left from an app change with a duration would otherwise turn A off partway
   through the night, and A's step would turn it straight back on.
3. Clear A's Smooth return fade and surface offset, if any.
4. Set A's Smart start run aside.
5. Mark A as owed a write, so it is rewritten from H's plan at once.
6. Log `one-side` with H. Save the mark.

Between the setting change and this tick (up to 30 s), rules 1 to 4 already
hold, because they read the configuration directly; only the cleanup waits.

**End** (mark present, A owns itself again, or H changed). Runs on the tick
before `tickSide(A)`, so A's own Smart start sees the result the same tick.
1. If A's sleeper is home again (an active sleeper: not when both are now
   away) and has Smart start on with detection live:
   - lying on their half (`presenceOf(A)` in, sensors fresh): record an entry
     now with `noteEntry(A, now)`, so their Smart start begins their curve as
     if they had just got into bed. (Today's code does the opposite: it lets
     the copy of H's curve run on and marks tonight as started. With no copy
     left on A, starting their own curve is the only way to keep them warm or
     cool by their own settings.)
   - presence says their half is empty: power A off; their Smart start turns
     it on when they get in;
   - presence can't tell (sensors stale): leave A as it is, to upstream. They
     may be lying on it, and with stale sensors Smart start could not see
     them get in to turn it back on.
2. Otherwise leave A to upstream (`applyBedConfiguration` already ran when the
   setting changed: weekly schedule, or off; with both away, off).
3. Log `one-side-ended`. Remove the mark.

Fork service disabled: `bedOwnerOf` answers "itself" for every side, so one
side ends. The release at start-up removes every `one-side:*` mark, so a later
re-enable runs the start steps again and clears anything stock code left on A
meanwhile; `releaseFollowing`'s job (hand the bed back to sleepypod with
`applyBedConfiguration`) stays.

Install day: the Pod now has the old `following:left` mark, which the new code
ignores. The first tick finds no `one-side:left` mark and runs the start steps,
which is correct. The old row stays in `fork.db`, unused.

## 6. Every path that touches a half, and what happens to it

| Path | Today | One side |
|---|---|---|
| Controller 1 s reconcile of A | A's own schedule mirror + A's own sessions/hold | H's plan (4.2) |
| Scheduler power-on/off jobs | Fire on H and A (`drivenSides`), each checking its own run-once | Fire on H only; A follows by A's step (4.3, one upstream line) |
| Scheduler temperature jobs | Reconcile H and A | Reconcile H only (same `drivenSides` line); A follows by A's step |
| `syncMirroredSide` / `applyBedConfiguration` | Set A's power from H's | Unchanged; consistent |
| Away start/return jobs | Power A, apply configuration | Unchanged; section 5 does the fork's part |
| Smart start on H | Run-once on H; powers H | Unchanged; A follows by rules 1 to 4 |
| Smart start timer refresh, always-on keepalive | Copy refresh step for A; keepalive per half | A owed a write after every write to H (4.3) |
| App, HomeKit, taps on A; MCP and MQTT (they call the device router) | Act on A | Redirected to H (4.4) |
| Firmware move on A with no handler (a tap with no gesture set) | Stays | A's step sees A's level differ and rewrites A (4.3) |
| Cover buttons on A | Step H, carry hold back | Step H from the target recorded at the first press; A owed a write (4.4) |
| Smooth return | Skipped on A when carrying | Skipped on A (4.4) |
| Run-once start on A from the app | Runs on A | Refused while one side lasts (4.4) |
| Run-once cleanup at wake | Turns its own half off | H's turns H off; A follows |
| Pump guard trip on A | A off | A off; H unaffected (rule 9) |
| Pump alert parking A (`pumpAlerts.ts` calls `device.setPower` off) | Parks A | Parks A: not redirected while A is guard-blocked (4.4) |
| Pump guard trip on H | H off | H off, A off (rule 3) |
| Firmware 8-hour timer | Per half | Kept in step (rule 4) |
| Upstream bed-exit auto-off | Per half, by each half's occupancy | Off on this Pod. **If turned on it would be wrong**: with the sleeper lying on A, H's half reads empty, auto-off turns H off, and A's step turns A off, so the bed goes off with her in it. It would need the redirect and the merged presence. Known gap. |
| Upstream auto-on | Per half | Off on this Pod. If turned on, it would power A alone and A's step would undo it. Known gap. |
| Upstream global max-on cap | Per half, skipping halves with a run-once | Off on this Pod. If turned on, A (no session of its own) could be cut while H runs, and A's step would turn it back on. Known gap. |
| Upstream autopilot | Per half | Not used here (0 automations). Known gap. |
| Alarms | H's alarm vibrates H's half | Unchanged. Vibrating both halves would be a separate upstream change; H has no alarms enabled. |
| Vitals, sleep record (Python) | Merged under H | Unchanged |

## 7. Alternatives considered and rejected

- **Keep copying (today).** Two sets of state kept in step; the source of
  most bugs found on 11-05.
- **Power follows whichever half changed last, no entry-point redirects.**
  Smallest upstream diff (no lines in the routers), but it has to guess who
  made a change from one-second snapshots, and a fault on one half (a
  firmware timer running out) would turn the whole bed off. Rejected:
  correctness over diff size. Cost of the chosen design, as built: 19
  changed lines in 6 stock files (`instance.ts`, `device.ts`, `runOnce.ts`,
  `jobManager.ts`, the HomeKit side controller, the gesture handler): 6
  imports and 13 one-line hooks, all next to fork lines already there.
- **Write A inside H's hardware write.** Instant, but writes A without A's
  lock (see 4.3). Rejected for safety.
- **Make the two halves share one lock.** The scheduler takes both locks,
  left then right, so a shared lock would deadlock. Rejected.
- **Merge the raw sensor signals into one detector.** Would need new
  thresholds and calibration. Merging the per-half calls is enough.
- **Redirect inside the controller's methods.** Callers already hold the
  pressed half's lock, so the controller would write H without H's lock.
  Rejected.

## 8. Tests

Replace `src/fork/smart/tests/following.test.ts`. New or changed tests, each
named for the rule it checks:

1. `bedOwnerOf`: every combination of bed mode, away flags, zone mode, and
   service running/disabled.
2. Controller with the real `instance.ts` dependencies (in-memory database):
   A reports H's hold, session target and hold end; writing a hold through A
   throws; clearing through A leaves H's hold; A's own rows are ignored while
   one side lasts and used again after.
3. A's step (`tickHalf`): H on → A on; H off → A off; H blocked → A off; A
   blocked → A stays off and H stays on; never touches H; H with no plan → A
   at H's reported temperature, not 75; A's level moved by the firmware →
   rewritten, except during a press wait on A; `isCurrent` false → nothing;
   a half that is not A → plain `reconcile`.
4. Timer: a hardware write to H, including a forced write with no plan, makes
   A's step rewrite A; deferred while a press wait is open on A.
5. Redirects: `setTemperature`, `setPower`, `resumeTemperature` on A act on H
   (router tests); debounce keyed by H; `setPower` off on a guard-blocked A
   parks A, not H; run-once start on A refused, cancel allowed; `drivenSides`
   returns H only while one side lasts.
6. Presses on A: step from the firmware move against the target recorded at
   the first press, including when the bed target changes during the wait;
   neutral level counts as 83; clamped at warmest; A rewritten when the bed
   target does not change; dropped when H is off, turned off or blocked at
   settle; logged once under H with the half; A off → Smart press for H;
   guard-blocked A → ignored; with Hold after adjustment Off, a hold until the
   curve's next change.
7. Smooth return does nothing on A while one side lasts.
8. Presence: the merged view as today's `bedPresenceOf` tests, moved to the
   collector; entries on A reach H; Smart noise's rolled-across rule still
   uses the half's own reading.
9. Transitions: start cancels A's session, hold, hardware deadline, fade and
   surface offset and sets its run aside; end with the sleeper in bed records
   an entry; end with the bed empty powers A off; end with both away records
   no entry; end with Smart start off leaves A to upstream; service disabled ends
   one side.
10. Surface reads the occupied half.
11. Stock write paths (3.4): for every non-test file outside `src/fork`, the
    count of `getTemperatureController()` plus `.setTemperature(` and
    `.setPower(` calls, compared exactly with a stored table. A changed count
    fails with the file name. Plain counts; the reasons stay in section 6.
12. Existing tests that mock `../smart/following` are rewritten:
    `holds.test.ts` (its press-for-home tests become test 6),
    `noiseSession.test.ts`, `service.test.ts`, `awayCard.test.tsx`.

Then `corepack pnpm vitest run` on `src/fork` and `src/components`, `tsc`,
`eslint`, and CI green.

## 9. Review brief

A reviewer should check the code against section 3.1, rule by rule, and
against the table in section 6, path by path. Specific risks to probe:

- Any writer that reaches A's hold, power or hardware without going through
  `bedOwnerOf` (search for `setManualLocked`, `powerOnLocked`,
  `powerOffLocked`, `writeHold`, `setTemperature(`, `setPower(`).
- Lock order: no code may hold one side's lock while waiting for the other's,
  except upstream's left-then-right pairs.
- The window between a settings change and the 30-second tick.
- The firmware press arriving while the bed target changes (the step is
  measured against the bed target before the press).
- Fail-back when the service stops mid-night.
- Section 3.4: each stock-file edit is one line next to the existing fork
  line; the follow core does not import Smart start, presence or the fork
  store; test 11's list matches the stock source.

## 10. Rollout

Status 2026-11-06: step 1 is done (f2cbe47c; the reviews are in section 11,
and the stock files gained only the hook lines, 19 lines in 6 files). Steps 2
to 4 are checks on a Pod and are not tracked in this repo.

1. Build as one feature commit (it replaces a feature; there is no separate
   bug fix in it). One medium review; fix its findings without a second round.
   Check drift afterwards with `git diff --stat upstream/main...pod5`: the
   stock files should gain only the hook lines listed in 4.2 to 4.4.
   At each later upstream merge, run the full fork tests before installing;
   test 11 names any new stock write path to decide on.
2. Install with the bed empty, after reviewing the night before. Rerun the
   setup script without `followSmartStart`.
3. On the Pod after install: both halves show the same target; a hold set from
   the app on A appears on H; turning A off in the app turns the bed off.
4. The next night: thermal state of both halves identical apart from about a
   second; presses on either half logged under H; both halves on and off
   together; no `following` events.

## 11. Review record

One adversarial review of this plan (medium effort, 11-05), checked against
the code. Twelve findings, all accepted and folded in above. They are listed
here so the reasons survive implementation and code review:

1. Pump-alert parking would have been redirected to H, and the bed turned off
   over a fault on A. Fix: the guard's flows are not redirected (4.4).
2. A firmware move on A that no code turns into a hold stayed for good. Fix:
   the loop compares A's level and rewrites it (4.3).
3. A press step could be lost when the bed changed during the press wait.
   Fix: target recorded at the first press; the loop leaves A alone during
   the wait (4.3, 4.4).
4. A press on A could turn the bed on, or hit a blocked H. Fix: H's state is
   checked at settle and the press dropped otherwise (4.4).
5. The scheduler's power jobs check each half's own run-once, so A flickered
   off at the weekly off time. Fix: `drivenSides` returns H only; the loop is
   A's only source of power (4.3).
6. Smart noise's rolled-across rule needs one half's own reading. Fix:
   `halfPresenceOf` (4.5).
7. A run-once started on A would power A from the router. Fix: refused (4.4).
8. With no plan, `invalidate` produced no write, so A's timer could run out.
   Fix: "owed a write", carried out by the loop with `powerOnLocked` (4.3).
9. A leftover hardware deadline on A. Fix: cleared at start (section 5).
10. End steps when both sleepers are away, and an overstated "no leftover".
    Fix: gated on an active sleeper; rule 10 reworded (3.1, section 5).
11. The auto-off and auto-on row understated the risk. Fix: corrected
    (section 6).
12. Writing H's hold through A would hide missed redirects. Fix: it throws
    (4.2).

Found correct by the review: every other hardware write goes through `apply`;
lock order; `smartFor(A)` with the scheduler's mirror; aliasing gives A H's
plan in every controller method; sessions carry no hardware deadline; MCP and
MQTT reach the device router; the Python modules merge vitals under H
whatever the zone mode; settings parsing ignores a stored `followSmartStart`;
the install-day start steps clear the old copy.

### Second round (11-05 evening): design and correctness reviews

Two reviews in parallel, medium effort, against the code, after section 3.4
was added. All findings below were accepted unless marked otherwise.

Design:
1. Upstream's own tick would still reconcile A beside a separate fork loop,
   rewriting A during a press wait. Fix: no fork loop; A's step runs inside
   upstream's tick (`tickHalf`), so A has one writer and inherits the tick's
   firmware gate, no-overlap guard and shutdown drain (4.3).
2. Edit `readBaseline` and friends one by one. Fix: one wrapper,
   `withOneSide`, around all the dependencies (4.2).
3. Redefining `presenceOf` as merged would silently change seven callers.
   Fix: `presenceOf` keeps its meaning; `bedPresenceOf` moves to the collector
   (4.5).
4. A list of stock write paths tied to function names is brittle and missed
   paths. Fix: per-file call counts (8, item 11).
5. Import purity for the core contradicts its need to know about press waits.
   Fix: dropped; the split is by file, and the press flag lives on `runtime`.
6. `bedOwnerOf` is on hot paths. Fix: prepared statements, no cache (4.1).
7. A hung service should hand back to stock. Fix: heartbeat in the liveness
   test (4.1).
8. Several places an implementer would guess (which reading, how to record an
   entry, what replaces `smartSourceOf`, which tests and app files change).
   Fix: named in 3.2, 4.3, 4.6, 4.7, section 5 and section 8.
9. Stock `SideCard.tsx` wording. Left alone on purpose (4.7).

Correctness:
1. (High) The controller's reconcile rewrote A during a press wait, so the
   first-press fix still misread presses. Fix: one writer (design 1), and the
   step measured from the last write to A (4.4).
2. The status poll can show the moved level before the press frame arrives,
   so an instant drift fix would erase the press. Fix: 6-second settle (4.3).
3. A press on A with no plan on H was lost. Fix: based on H's reported target
   (4.4).
4. A stuck loop would never end one side. Covered by design 1 and 7.
5. A firmware move on H with no handler is neither undone nor followed.
   **Accepted as a known gap**: stock sleepypod behaves the same for any half,
   and both halves come back together at the next change to the plan.
6. Timing wording; a hardware duration over 8 hours on H lets A's own timer
   run out first, and A's step turns it back on within one status poll.
   **Gap accepted**; rules 2 and 3 reworded.
7. The step must leave a guard-blocked A alone, including its recovery probe.
   Already so: step 1 of A's step (4.3).
8. Redirected taps mis-recorded H's alarm as ended. Fix: only the temperature
   and power tap actions are redirected (4.4).
9. One-side marks were never removed when the service starts disabled. Fix:
   the release removes them (section 5).
10. The iPhone curve view and cancel on A do not act on the bed. **Accepted**
    and stated (4.7). HomeKit and the app both leave a guard-blocked A on its
    own half, so they agree.

### Code review (11-05 evening, medium, one round)

Six findings against the built code, all checked against the source:

1. A quick second press on A, before A was rewritten, counted the first
   press again. Fixed: a measured press becomes A's new base
   (`noteMeasured`). Test added.
2. A failed automatic power-off of A left it running while the controller
   said off, so the step never retried. Fixed: the step also powers A off
   when the firmware reports it on. Test added.
3. Ending one side with stale sensors turned A off under a sleeper who may
   be lying on it. Fixed: power off only when presence says the half is
   empty (section 5). Test added.
4. After a silent spell the bed was stock, but the marks survived, so the
   start steps never ran again. Fixed: the Smart start tick checks liveness
   before renewing the heartbeat and forgets the marks after a silent spell.
   Test drives the tick.
5. Tests weaker than section 8 says. Added: the no-plan forced write, the
   in-flight second press. **Skipped**: router, HomeKit, gesture and
   scheduler tests for the one-line hooks, and the real `instance.ts`
   dependencies (the rig uses fakes): the hooks are single calls to
   `controlSideOf`/`bedOwnerOf`, which are tested, and the stock suites
   for those files need the Pod's socket and fail on Windows anyway; CI runs
   them. The stock-call counter counts controller acquisitions, not each
   call through a held controller: a coarse tripwire by design.
6. Refusal wording. Fixed (4.6).
