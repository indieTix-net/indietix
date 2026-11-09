# What IndieTix does

IndieTix is ticketing for independent cinemas and venues, built on Square. It started as the box office for Liberty Hall in Lawrence, Kansas, and grew into a full platform.

- **Square handles the sale.** Tickets are Square items, sold at the venue's register and on its Square Online store. IndieTix never handles card details.
- **IndieTix handles everything around the sale:** QR-code tickets by email (and by text, if the venue has texting set up), a door scanner that runs on any phone, tablet or laptop, order management (refunds, resends, transfers), box-office reports, and a marketing scheduler.
- **No per-ticket fees to ticket buyers.** IndieTix doesn't add a fee to each ticket.
- **Each venue is fully separate:** its own database, storage and settings. One venue can never see another's data.
- **Free and open source.** The code is public at https://github.com/indieTix-net/indietix under the AGPL license; anyone can run it on their own AWS account. Hosted IndieTix is the same software, run for the venue, on a monthly plan (see https://indietix.net for pricing).
- **Who's behind it:** Wolffebrothers LLC.

## A night at the box office, start to finish

1. **Add the show.** Staff add a movie or event once, with its showtimes ([Adding movies and events](04-adding-movies-and-events.md)). IndieTix creates the Square item.
2. **Sell it.** Buyers pay through Square: online, at the register, or anywhere Square sells ([Selling tickets](03-selling-tickets.md)).
3. **Deliver the ticket.** Within a minute or so the buyer gets a QR-code ticket by email, or by text if they've opted in.
4. **Check people in.** Door staff scan tickets on a phone ([At the door](05-at-the-door.md)); [Today's Dashboard](05-at-the-door.md#todays-dashboard) shows sold and checked-in counts for each show.
5. **Handle changes.** Refunds, resends, transfers and contact fixes happen on the Orders and tickets pages ([Orders, refunds and resends](06-orders-refunds-and-resends.md)).
6. **Report.** Box-office reports go to film-industry reporting services every night, and the Event Report and Insights answer questions about sales ([Reports and Insights](07-reports-and-insights.md)).

## What's in the menu

| Menu item | What it's for | Who sees it |
|---|---|---|
| Today's Dashboard | Today's shows with sold and checked-in counts | Door, view or edit permission |
| Ticket Scanner | Scan tickets with the camera | Door, view or edit permission |
| Manual Checkin / List Tickets | Find any ticket, check in by hand, transfer, print | Door, view or edit permission |
| List Orders | Find orders, resend, refund, edit contact details | View or edit permission |
| Event Report | Sales and check-ins, grouped and exported | View or edit permission |
| Insights | Questions about your sales in plain English | Admin permission |
| Movie Info Lookup | Add a movie and its showtimes | Edit permission |
| Event Info Entry | Add a live event and its showtimes | Edit permission |
| Marketing Schedule | Plan and approve social and email posts | Marketing permission |
| Email List | Marketing email subscribers | Marketing permission |
| User Management | Staff accounts and permissions | Main login only |
| Client Settings | Everything about the venue's setup | Main login only |
