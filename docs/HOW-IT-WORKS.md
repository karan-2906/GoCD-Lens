# How GoCD Lens works

No technical background needed. If you know what a browser tab is, you know enough to read this.

---

## 1. The problem, with no jargon

Imagine a **factory** that builds your company's software. All day long it takes the code people
write, assembles it, tests it, and ships it. That factory is called **GoCD**.

The factory has many **assembly lines** running at once — one for the website, one for payments,
one for the mobile app. Each line is called a **pipeline**. A pipeline has **stages** that happen
in order (build it → test it → ship it), and each stage has **jobs**, which are the individual
workers doing the actual tasks. A stage can have a dozen jobs running side by side.

Your job, as someone who works there, is to know: _is my thing working, or did it break?_

The factory has two ways to tell you.

**The information desk.** You phone up and ask, "how is the payments line doing?" and a clerk reads
you the answer. This is called the **API**. It is a plain, boring, reliable service. It almost
always answers.

**The big display board in the lobby.** It shows everything at a glance, with colours and pictures.
This is the **web interface** — the page people normally open in a browser.

Here is the annoying part: **the display board and the information desk are different machines.**
The board can go dark, freeze, or take two minutes to load while the information desk is answering
perfectly. When the board breaks, everyone assumes the factory is broken. It usually isn't.

**GoCD Lens is your own display board.** It ignores the factory's board entirely, phones the
information desk itself, and draws the picture for you. When the factory's board goes dark, yours
keeps working — because it was never using the board in the first place.

---

## 2. What a browser extension actually is

An extension is a small program that lives _inside_ your browser. It is not a website you visit
and not an app you install on your computer. It rides along inside Chrome (or Edge, or Brave).

GoCD Lens shows up in three places:

- **A small icon next to your address bar.** Click it and a little panel drops down — a five-second
  glance at what's happening. On the icon itself there's a tiny coloured number, called the
  **badge**.
- **A full page in its own tab**, which is the real dashboard with everything on it.
- **A settings page**, where you tell it which factory to phone and how to identify yourself.

---

## 3. The four parts inside it

Think of the extension as a small office with four rooms.

### The back office — where all the phone calls happen

There is exactly one room with a telephone in it, and exactly one employee who works there. In
technical terms it is called the **service worker**. Everything you see on screen is drawn by other
rooms, but **only this one employee is ever allowed to phone the factory**.

This employee is also the only one who holds your **password or access token** — the thing that
proves to the factory that you are allowed to ask. It is kept in that room and never handed out.

### The display rooms — what you actually look at

Three rooms draw things on screen: the full dashboard, the little popup panel, and the settings
page. **None of them has a telephone.** When the dashboard wants to know something, it slides a
note under the door to the back office: _"what's happening with the pipelines?"_ The employee makes
the call and slides back a note with the answer — just the answer, never the password.

This sounds like extra work. It is deliberate, and section 8 explains why.

### The filing cabinet — where things are remembered

A cabinet in the corner holds the address of your factory, your settings, the pipelines you marked
as important, and a copy of the last answer the factory gave. It is a file on your own computer, in
your own browser. Nothing in it is ever uploaded anywhere.

### The tiny sound booth

Here's a strange one. The back-office employee can make phone calls but **cannot make a sound** —
browsers do not allow that particular kind of program to play audio at all. So there is a tiny
soundproof booth whose only purpose is to play a short chime when something you care about
finishes. The employee knocks on the booth door; the booth plays the sound.

---

## 4. Setting it up, step by step

**You type the factory's address.** Something like `https://gocd.mycompany.com/go`. This is the same
address you'd normally open in a tab.

**You choose how to prove who you are.** There are three ways:

1. **"Use my existing login"** — if you're already signed in to the factory in this browser, the
   extension rides that. **Nothing is saved at all.** This is the default and the safest.
2. **An access token** — a long random string the factory gives you, like a visitor badge. It
   survives being signed out, and can be cancelled on its own if it leaks.
3. **Your username and password** — for older factories that don't offer badges.

**You press Connect, and two things happen.**

First, the browser asks your permission out loud: _"allow GoCD Lens to access gocd.mycompany.com?"_
Until you say yes, **the extension cannot reach any website at all** — not your factory, not
anything. It ships knowing nothing and permitted nothing. You grant it one address, and only that
one.

Second, before saving anything, the employee phones the factory once to check your details actually
work. If you mistyped the address or the badge is wrong, you find out immediately — instead of
staring at an empty dashboard later, wondering what's broken.

---

## 5. What happens while you watch it

### Asking once, not six thousand times

A big company might have thousands of pipelines. The naive approach — ask about each one, one at a
time — would mean thousands of phone calls every few seconds. That would flatten the factory's
switchboard. Your monitoring tool would become the outage.

So the employee asks **one question** that covers everything: _"give me the state of every pipeline
I can see."_ One call, one answer, however many pipelines there are.

### The "anything new?" trick

Asking every ten seconds still sounds wasteful, so there's a shortcut.

When the factory answers, it attaches a little slip with a code on it — think of it as a version
stamp. Next time, the employee sends that stamp along with the question: _"I've got version 47 —
anything changed?"_ If nothing has, the factory replies **"nope"** and nothing else. That reply is
almost empty. It costs the factory nearly nothing to send and nearly nothing to receive.

Only when something has genuinely changed does the full answer come back.

### Nobody looking? Then nobody asks

- If your dashboard tab is **hidden behind other tabs**, it stops asking entirely. Watching a page
  you can't see is pure waste.
- If you have **three dashboard tabs open**, they don't each make their own call. The first one
  asks, and the other two are handed the same answer. Three tabs, one phone call.
- If **no tab is open at all**, the extension checks on a schedule you choose — and out of the box
  that schedule is **never**. Background checking is off until you deliberately turn it on, because
  traffic happening while nobody is watching deserves an explicit yes.

### Nothing changed? Then nothing is redrawn

If the answer comes back identical to last time, the screen is left alone. Only the little "updated
12s ago" clock ticks over. Redrawing an identical screen would throw away your scroll position and
make the page flicker for no reason.

---

## 6. What you see, and why

### Colours that say where it broke

Each pipeline is a card. Along the bottom of the card is a **strip of coloured segments — one per
stage, in order.** Green, green, red means: it built fine, it tested fine, and it died while
shipping. You learn _where_ it broke without clicking anything.

### Searching by initials

Type `wabp` and it finds `web-app-build-prod`. You don't have to type the whole name or even
remember it exactly — just the letters, in order. This is called **fuzzy search**, and it's the
difference between finding something in a second and scrolling through a list of thousands.

### A star and a bell, which are different things

- A **star** pins a pipeline to the top of every list. It's for things you look at often.
- A **bell** means _interrupt me_. You get told when it starts and when it finishes.

They're separate on purpose. Wanting something close to hand and wanting to be interrupted by it
are two different wishes, and mixing them means you either lose things you care about or get
pestered by things you don't.

### The little number on the icon

The badge counts **what's running right now**, in blue. When nothing is running it turns red and
counts **what's failing** instead.

Running first, deliberately. A failure can sit there for days, and a badge stuck on the same red
number all week teaches you to ignore it. What's running is the thing that's actually changing.

### Re-running one job instead of twelve

A testing stage often has a dozen jobs side by side. Sometimes one of them fails for a silly
reason — a flaky test, a slow network — and you just want that one to try again.

So each job has a **tick box**, with the failed ones already ticked. You adjust if you like, press
the button, and only those jobs run again. Re-running all twelve to retry one would tie up twelve
machines for nothing.

If you tick _everything_, that's just "run the whole stage again", and it's sent as exactly that.

### Reading the logs as they happen

When a job runs, it produces a long stream of text — the **log**. Open it and you see it fill in
live. Rather than re-downloading the whole thing every few seconds, the extension says _"I've read
up to line 4,000, what's after that?"_ and receives only the new lines.

Errors are tinted red, warnings amber, so the thing that went wrong stands out in a wall of text.

---

## 7. When the network disappears

A lot of these factories sit behind a **VPN** — a private tunnel you have to be connected to.
Tunnels drop.

When that happens, the extension **keeps showing you the last thing it knew**, with an honest
banner at the top saying so and when it was from. You can still read yesterday's failure while you
reconnect. That's why a copy of the last answer is kept in the filing cabinet: so the screen is
useful even when the phone line is dead.

There's also a button called **"Is it GoCD, or is it me?"**. It phones the information desk and
checks the display board separately, and times both. If the desk answers in 80 milliseconds and the
board times out after ten seconds, it tells you plainly: the factory is fine, the board is broken.
That is the exact situation this whole extension exists for.

---

## 8. Why it's built this way — the safety part

This is the part worth understanding even if you skip everything else.

**Only one room has a telephone.** Because the display rooms cannot make calls, a bug in the drawing
code _cannot_ leak your password. It never had it. This isn't a promise to be careful; it's an
arrangement where the mistake isn't possible.

**It can't read the pages you browse.** Many extensions insert themselves into every website you
visit — that's how they change what pages look like. GoCD Lens does none of that. It has no ability
to see, read, or touch any page you open. It also never asked for permission to see your tabs, your
browsing history, or your cookies.

**It starts out able to reach nothing.** A freshly installed copy has permission to contact zero
websites. You grant it one address when you press Connect. That's the whole list, forever.

**Nothing is uploaded, and nothing is synced.** Browsers offer two filing cabinets: a local one, and
a synced one that copies to your account and every other machine you use. GoCD Lens uses the local
one only. The synced one is never touched anywhere in the code — and an automatic check reads the
actual files and fails if anyone ever changes that, which blocks the change from being committed.

**Text from the factory is never treated as instructions.** Build logs and commit messages are
written by other people and machines. If such text were dropped carelessly onto a page, it could
smuggle in commands that the browser then obeys. So every piece of text arrives as _text only_ —
labelled as something to display, never as something to run.

**No outside code, no tracking.** Every picture, sound, and line of code is inside the extension
package. Nothing is fetched from anywhere on the internet, and no usage data is collected about you.
Your factory is the only place the extension ever connects to.

### One honest caveat

If you choose to store a badge or password, it sits in that local filing cabinet **unencrypted**.
No website can read it, and no other extension can read it — but anyone who can read the files on
your computer, as you, could read it. Browser extensions have no access to the system keychain, so
there's no safer place available.

This is exactly why "use my existing login" is the default: it stores nothing at all.

---

## 9. A small glossary

| Word               | What it means here                                                     |
| ------------------ | ---------------------------------------------------------------------- |
| **GoCD**           | The factory — the system that builds and ships your company's software |
| **Pipeline**       | One assembly line, e.g. "build the website"                            |
| **Stage**          | One step of a pipeline, in order: build → test → ship                  |
| **Job**            | One worker inside a stage; a stage can run many at once                |
| **API**            | The information desk — a plain service that answers questions reliably |
| **Extension**      | A small program living inside your browser                             |
| **Service worker** | The back office; the only part allowed to make phone calls             |
| **Badge**          | The little number on the toolbar icon                                  |
| **Polling**        | Asking again every so often, because the factory never rings you       |
| **Cache**          | The copy of the last answer, kept so the screen works offline          |
| **Token**          | A visitor badge — proves who you are, and can be cancelled on its own  |
| **VPN**            | A private tunnel you connect through to reach internal company systems |

---

## 10. The one-paragraph version

GoCD Lens phones your build system's information desk directly instead of relying on its web page,
which is the part that tends to break. It asks one cheap question every few seconds, stops asking
when nobody is looking, remembers the last answer so the screen still works when the network
doesn't, and draws you a picture where colour tells you what's broken and where. Exactly one part of
it is allowed to make network calls and hold your credentials, which is what makes the promises on
the rest of this page structural rather than aspirational.
