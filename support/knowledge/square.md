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

## Refunds
- Refund or cancel an order from IndieTix's **Orders** page (or a single ticket from the tickets page). The refunded tickets stop working at the door straight away, and the order shows who refunded it and why.
- Refunds made directly in Square's own dashboard or app don't cancel the IndieTix tickets, so refund through IndieTix.
