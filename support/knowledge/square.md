# Square

## Connecting Square
- IndieTix connects to the venue's Square account with **Connect Square** (signing in to Square and approving access). No developer account or pasted keys are needed, and access renews itself.
- **Square shows as disconnected, or tickets stopped sending?** Someone may have removed IndieTix's access in Square. Open **Client Settings → Reconnect Square** and sign in with the venue's Square account. Orders placed while disconnected don't get tickets automatically; email support and IndieTix will help resend them.

## Selling tickets
- Tickets are sold through Square: at the register, on the venue's Square Online store, or anywhere else Square sells.
- When a Square order includes a ticketed item, IndieTix makes the QR-code tickets and emails them to the buyer within a minute or so.
- Square Online should be set to **pickup only** for ticket items (no shipping). IndieTix reminds you after adding a movie or event.

## Adding movies and events
- **Movies:** the Movie Info Lookup page searches the movie (title, rating, runtime, cast, plot) so you can check it and create it in one step. It needs an OMDB API key in Client Settings.
- **Events** (concerts, comedy, trivia, private rentals and so on): the Event Info Entry page.
- Add as many showtimes as you like. Each showtime is a choice on the Square item, so it sells at the register and online the same way.
- IndieTix creates the Square item for you, with the right settings. To change a price or showtime after it's created, change it in Square.
- Past showtimes expire and finished runs archive themselves.
- Showtimes can also be added to Google Calendar if it's set up in Client Settings.

## How a ticket item is built in Square
IndieTix's Add Movie and Add Event pages build all of this for you. It's here for when someone needs to change an item by hand in Square, or make one from scratch.

**1. The item's custom attributes.** These are set on the item, in the custom attributes section of Square's item editor.
- **UseQRCode** (yes/no): this is the switch. IndieTix only makes tickets for items where UseQRCode is turned on. If an item sells but no tickets go out, check this first.
- **EventType** (a choice, for example Movie or Live): what kind of event it is, used on reports.
- **Distributor** (a choice): who the film or show comes from, used on box office and distributor reports.
- **Online Display Name** (text): the name shown online, usually the same as the item name.
- The four attributes must exist in the venue's Square account with exactly these names. Setting one on a single variation instead of the item overrides the item's value for that ticket type only.

**2. Variations are the ticket types.** Each variation is one kind of ticket with its own price: movies start with Adult, Child and Senior, and events with Regular. The variation's name is printed on the ticket as its type and used on reports, so name them the way you want them to read (for example "Student" or "VIP").
- To change a price, edit that variation's price in Square.
- To add a ticket type, add a variation to the item. It's ticketed automatically, because UseQRCode is set on the item.
- Square counts stock per variation, not per showtime. If stock tracking is on, the count covers every showtime of that ticket type.

**3. The "Show Time" modifier list holds the date and time.** Each item has its own modifier list named **Show Time**, set to require exactly one choice, so every sale picks a showtime. Each modifier is one showtime, priced at $0.
- Write each showtime exactly like this: `Sun 01-18-2026 7:00 PM (Spacement)`. That's the day, the date as MM-DD-YYYY, the time with AM or PM, and the room in parentheses. Leave off the parentheses if the venue has one room.
- IndieTix reads the date and time for the ticket, the door scanner and reports from this text, and the room from the parentheses. A typo in the date can put the wrong date on tickets, so copy an existing showtime and change only what differs.
- To add a showtime, add a modifier to that item's Show Time list in the same format. To cancel one, remove its modifier, but refund anyone who already bought it, through IndieTix.
- Keep the list's name as Show Time, and give each item its own list. Don't share one list across items, because the cleanup below works per list.

**4. Cleanup.** A few hours after a showtime starts, IndieTix removes it from the list so it can't be sold. When every showtime on an item has passed, the list is removed and the item is archived in Square. Archived items can be restored in Square if a run is extended.

**Other settings.**
- Each unit sold is one ticket: a quantity of 4 makes 4 tickets.
- On Square Online, set ticket items to **pickup only** (no shipping or delivery). Square doesn't let IndieTix set this, so it's a one-time manual step per item.
- An item made by hand, rather than in IndieTix, works the same way if it follows steps 1 to 3.

## Refunds
- Refund or cancel an order from IndieTix's **Orders** page (or a single ticket from the tickets page). The refunded tickets stop working at the door straight away, and the order shows who refunded it and why.
- Refunds made directly in Square's own dashboard or app don't cancel the IndieTix tickets, so refund through IndieTix.
