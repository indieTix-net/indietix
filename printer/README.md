# printer

**Last Edited:** 2026-10-28

A small local print agent for printing IndieTix tickets to a physical label printer at the venue.  The "Print Ticket" action on QRScanner's Products page.

## Overview 

This agent fetches a ticket's PDF, rasterizes it, rotates and rescales it to fit the loaded label stock, and sends it directly to a network-connected Brother QL-820NWB over TCP (port 9100, the standard raw/JetDirect-style printing every network printer supports) — no printer driver, no OS print dialog, no Windows-only SDK involved anywhere in the chain. Both continuous rolls (feed length floats to match the ticket's aspect ratio) and die-cut, fixed-size labels (ticket is scaled to fit and centered on the label instead) are supported — see Label stock below.

One automatic retry: the QL-820NWB drops into a power-save state after a few idle minutes where it stays associated to WiFi but the first print attempt can time out waking it up. `printTicket()` retries once, ~2s later, before surfacing a failure — still one click from the operator's side, not a background queue.

## Architecture

**Run one instance of this agent, not one per computer.** It's meant to run once on the venue's local network (any one of the till computers, or a small dedicated always-on box), and every computer's browser on that network calls this same instance over the LAN — by its LAN IP address, not `localhost`, unless that specific browser happens to be running on the same machine as the agent.

```
QRScanner (browser, any till computer)
  -> POST /print {pdfUrl}  [agent's LAN address]
      -> fetch the ticket PDF (presigned S3 URL, same one "View Ticket" uses)
      -> rasterize + rotate + rescale to fit the label roll
      -> send over TCP :9100 to the Brother QL-820NWB's LAN IP
```

QRScanner's backend runs on AWS Lambda and has no network path to anything on the venue's local network — this agent is the only thing that can actually reach the printer, which is why it has to be a separate, locally-running service rather than another Lambda route.

## Hardware

**Brother QL-820NWB** (or any Brother QL/PT/TD-family printer with network/TCP support — see [`@thermal-label/brother-ql-node`'s hardware table](https://github.com/thermal-label/brother-ql) for the full list). Needs to be network-connected (WiFi or Ethernet), not USB-only, so every computer on the LAN can reach it directly. Set a DHCP reservation for its IP on your router so it doesn't drift.

**Label stock:** any media in `@thermal-label/brother-ql-node`'s catalog (`discovery.listMedia()`) works — both continuous rolls (default: DK-22205, 62mm continuous, media id `259`) and die-cut, precut labels (e.g. DK-11201, 29×90mm / 1.1×3.5in, media id `271`; verified live at Liberty Hall). Switching stock means setting both `MEDIA_ID` and `PRINT_WIDTH_DOTS` in `.env` to match the new media's `id`/`printableDots` — the two are separate env vars on purpose, so a typo shows up as a visibly wrong `/preview` instead of being silently masked.

## Setup

```
npm install
cp .env.example .env
# edit .env: set PRINTER_HOST to your printer's LAN IP
npm start
```

Then set `window.INDIETIX_PRINT_AGENT_URL` in QRScanner's `config.js` (see that repo) to this agent's LAN address, e.g. `http://192.168.1.42:9191`. Leave it unset/blank for any venue that doesn't use ticket printing — "Print Ticket" only appears on the Products page when this is configured.

## Endpoints

- `POST /print` — `{ pdfUrl }`. Fetches, rasterizes, and sends to the configured printer. No auth of its own — trusts anything that can reach it on the LAN, same trust model as a shared office printer. **Don't port-forward this to the internet.**
- `POST /preview` — same `{ pdfUrl }` body, same rendering pipeline, but returns a PNG instead of printing. Useful for checking layout/scale without burning a physical label, or for verifying the pipeline before the printer is physically on hand — see `createPreviewOffline` in `src/printTicket.mjs`.
- `GET /health` — liveness check.

## Keeping it running

This is meant to run continuously on whichever machine hosts it. Use a process manager appropriate to that machine's OS — `pm2`, a systemd service, a Windows service wrapper, or a macOS `launchd` agent — so it survives a reboot and restarts if it crashes. Not included here since it's genuinely host-OS-specific.
