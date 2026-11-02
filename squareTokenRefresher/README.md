# squareTokenRefresher

Keeps Connect Square (OAuth) venues' Square access tokens fresh. Square OAuth access tokens expire after 30 days, so this Lambda runs daily and renews any venue's token once fewer than 23 days remain, which works out to about weekly.

- **Finds venues** by their refresh-token secrets, `indieTix/square/clients/<clientId>`. QRScanner's Connect Square callback creates them.
- **Saves the new access token** to the venue's existing `SQUARE_ACCESS_TOKEN` setting, so every other Lambda keeps working unchanged.
- **Emails on failure:** the venue's contact, `OWNER_BCC_EMAIL` and `OPERATOR_ALERT_EMAIL`, from the venue's `SENDER_EMAIL`. When Square says access was revoked, the email tells the venue to click "Reconnect Square".
- **Venues are independent.** One venue failing never stops the others, and the run never throws.
- **Tokens are never logged.**

Deployed by `infrastructure/bootstrap.sh` (stack `square-token-refresher`). It does nothing until `SQUARE_APP_ID` is set in `bootstrap.config.sh`.

```bash
npm install
npm test   # needs Docker (test-db-harness starts a disposable Postgres)
```
