# Selling tickets

Tickets sell through Square; IndieTix turns each sale into tickets and delivers them.

## Connecting Square

- IndieTix connects to the venue's Square account with **Connect Square** (signing in to Square and approving access). No developer account or pasted keys are needed, and access renews itself.
- **Square shows as disconnected, or tickets stopped sending?** Someone may have removed IndieTix's access in Square. Open **Client Settings**, choose **Connect Square** again and sign in with the venue's Square account. Orders placed while disconnected don't get tickets automatically; email support and IndieTix will help resend them.

## Where tickets sell

- Tickets are Square items, so they sell at the register (Square POS), on the venue's Square Online store, or anywhere else Square sells.
- When a Square order includes a ticketed item, IndieTix makes the QR-code tickets and emails them to the buyer within a minute or so. Each unit sold is one ticket: a quantity of 4 makes 4 tickets.
- At the register, ask for the buyer's email so the ticket can be sent. For a walk-up with no email, the ticket can go to the venue's Owner BCC Email (Client Settings) instead, or you can let them in on the spot.

## Square Online: pickup only

Set ticket items to **pickup only** (no shipping or delivery) on Square Online. Square doesn't let IndieTix set this, so it's a one-time manual step per item; IndieTix reminds you after adding a movie or event.

## What the buyer gets

1. A confirmation email from the venue's Sender Email, with a PDF ticket for each seat. Each ticket has a QR code; the PDF doesn't include the buyer's personal details.
2. If the venue has texting set up, a link in the email to get tickets by text instead ([Text-message tickets](08-marketing-and-texting.md#text-message-tickets)).
3. At the door, staff scan the QR code from the phone screen or a printout.

## One per buyer items

For free samples or limited giveaways, list item names under **Client Settings → One Per Email Items**. Each email address then gets one ticket for that item.
