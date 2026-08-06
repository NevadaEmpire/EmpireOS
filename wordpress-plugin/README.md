# CRM single sign-on connector

1. Copy `travel-empire-dialer-sso.php` to
   `wp-content/plugins/travel-empire-dialer-sso/` on the CRM host.
2. Copy the value from `/etc/travel-empire/crm-sso-secret` on the dialer host.
3. Add it to the CRM `wp-config.php` before the “stop editing” line:

   `define('TE_DIALER_SSO_SECRET', 'PASTE_THE_PRIVATE_VALUE_HERE');`

4. Activate **Travel Empire Dialer SSO** in WordPress.

The signed link expires in 60 seconds, carries no password, accepts only
`@travelempire.org` users, and creates the dialer session after verification.
The private secret must never be placed in screenshots, source control, or chat.
