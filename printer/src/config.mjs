// Config is all env-driven -- no venue-specific values committed to the
// repo. Copy .env.example to .env and fill in your own printer's IP.
import 'dotenv/config';

export const PORT = parseInt(process.env.PORT || '9191', 10);

// The Brother QL printer's LAN IP. Set a DHCP reservation for it on your
// router so this doesn't drift -- the printer has no mechanism to tell
// this agent "I moved."
export const PRINTER_HOST = process.env.PRINTER_HOST || '';

// Passed explicitly to discovery.openPrinter() rather than letting it
// auto-identify the model via SNMP. Auto-identify adds a real (and, if
// SNMP is blocked on the venue's network/VLAN, a FAILING) round trip to
// every single print -- confirmed directly: opening by host alone with
// no real printer at that address fails after a 2s SNMP timeout with
// "pass deviceKey" in the error. Default here is QL_820NWBc, the
// bench-verified model in @thermal-label/brother-ql-core's device
// registry (tcp port 9100, autocut: true, real test reports on file --
// see the hardware table in that package if a different model is ever
// used; QL_810W works too but is registry-marked "untested/expected"
// rather than verified).
export const DEVICE_KEY = process.env.DEVICE_KEY || 'QL_820NWBc';

// Media descriptor id 259 = "62mm continuous (DK-22205)", the standard
// plain continuous roll for QL printers -- 696 printable dots wide
// (~2.3in at native 300dpi). Die-cut (precut, fixed-size) stock works
// too -- renderTicket.mjs branches on media.type to scale-and-center
// instead of letting the feed length float. See
// @thermal-label/brother-ql-node's discovery.listMedia() for the full
// catalog if a different stock is ever used.
export const MEDIA_ID = parseInt(process.env.MEDIA_ID || '259', 10);

// Target print width in dots, matching the media's printable area.
// Kept separate from MEDIA_ID (rather than looked up from it at startup)
// so the rasterization math below is simple and doesn't need an open
// printer connection just to compute dimensions.
export const PRINT_WIDTH_DOTS = parseInt(process.env.PRINT_WIDTH_DOTS || '696', 10);
