# Troubleshooting

Common problems at the box office and how to fix them.

**A buyer didn't get their ticket.** Find the order on **List Orders** and check the email address. Fix it with **Edit Order** if needed, then **Resend Email**. Ask the buyer to check their spam or junk folder too. ([Orders, refunds and resends](06-orders-refunds-and-resends.md))

**An item sold but no tickets were made.** Check the item in Square: its **UseQRCode** attribute must be on. Then check that the showtime text follows the format in [How a ticket item is built in Square](04-adding-movies-and-events.md#how-a-ticket-item-is-built-in-square). If Square was disconnected when it sold, email support and IndieTix will help resend.

**Tickets stopped sending for everything.** Open **Client Settings** and check Square is connected; if not, choose **Connect Square** again. Check the status page too.

**The scanner says a ticket is invalid.** Look the ticket up on **Manual Checkin / List Tickets**. Refunded, cancelled and transferred tickets are refused on purpose; a transferred ticket's new holder has a new code.

**The scanner says "already checked in".** That ticket has been scanned before. If it was a mistake, use **Actions → Check Out** on the tickets page.

**The camera won't start.** Allow camera access for the site in the browser, make sure no other app is using the camera, and reload the page. On iPhone, use Safari or Chrome and check Settings → the browser → Camera.

**A staff member can't see a page.** Their account doesn't have that permission ([Staff and permissions](09-staff-and-permissions.md)). After changing it, they need to log out and in again.

**Movie Info Lookup doesn't find anything.** It needs an OMDB API key in **Client Settings → API Configuration**. Try the title without "The", or add the year.

**Add Movie or Add Event says a Distributor choice is missing.** The name in **Client Settings → Square Ticket Items** isn't one of the Distributor attribute's choices in Square. Add the choice in Square and set it on the item.

**A refund in Square didn't stop the ticket.** Refunds made in Square's own dashboard or app don't cancel IndieTix tickets. Use **Mark as Invalid** on the ticket, and refund through IndieTix next time.

**Prints are failing.** Turn the printer off and on, check it's on the network, and make sure only one copy of the print agent is running.

**A nightly report failed.** The alert email says which delivery failed. Check that destination's details under **Client Settings → FTP Settings**, then email support if it keeps failing.

**Still stuck?** Email support@indietix.net with your Client ID, what you clicked and the exact message you saw.
