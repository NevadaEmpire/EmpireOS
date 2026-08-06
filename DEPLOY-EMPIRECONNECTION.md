# EmpireConnection deployment

This source overlay keeps the working SIP, auto-answer, connected-beep, queue, SSO, and advisor-extension behavior while adding the EmpireConnection workspace, lead warehouse, reusable dialing filters, and list-distribution engine.

## Install on the dialer server

Upload the archive to `/tmp/EmpireConnection-Lead-Command-Center-Views-2026-08-01.tgz`, then run:

```bash
cd /home/teadmin/dialer-showtime

sudo tar -czf /home/teadmin/empireconnection-before-update.tgz \
  src public package.json package-lock.json

sudo tar -xzf /tmp/EmpireConnection-Lead-Command-Center-Views-2026-08-01.tgz \
  -C /home/teadmin/dialer-showtime

sudo docker compose up -d --build --force-recreate
sudo docker compose logs --tail=80 app
```

Open EmpireConnection through EmpireInsights and perform a hard refresh once.

## Included

- EmpireConnection dialer branding and EmpireInsights CRM naming; no JustCall references.
- Strictly separated views: Admin opens to campaign setup, lead management, layout/rules, advisor administration, and reporting without loading or displaying the SIP phone; Advisor opens to customer search, the working phone, campaigns/scripts, dispositions, notes, Mason, and personal performance.
- Jake receives an Admin View / Advisor View switch. The default Admin View does not register Ext 1003; Advisor View deliberately connects Ext 1003 when Jake needs to make calls or appear as a Manager TO.
- Universal advisor search at the top opens EmpireInsights customer results for name, email, phone, booking number, transaction ID, authorization code, address, or city.
- Official supplied branding: EmpireInsights logo in Admin View and EmpireConnections logo in Advisor View and on the working phone display.
- Live admin wait-time reporting by advisor: current wait since the last completed call, average and longest gaps between today’s connected calls, calls today, talk time, status, and last-call end time. Current waits count live and the server refreshes the table every 30 seconds.
- Working 3D Yealink-inspired phone, call timer, keypad DTMF, green call, red end-call, and TO transfer controls.
- Existing incoming-call auto-answer and connected beep retained for every advisor.
- Admin-only Layout Editor for workspace order, exactly three selectable customer fields, and disposition add/remove/rename/reorder/color.
- Default dispositions ordered: Not Interested, DNC, Call Back, No Answer, Send Email, Voicemail, Language Barrier, Sale.
- Advisor section order begins with Phone / Incoming Group, then Dispositions, then Customer Information. Existing saved layouts are migrated once so Dispositions move directly underneath the phone while the correctly placed Notes/Mason section remains intact.
- Brushed-nickel, saturated 3D dispositions with strong drop shadows and no pastel treatment.
- Internally scrolling Zoom, in-person, and script panels.
- Autosaving lead notes above Mason and campaign scripts with name merge fields.
- EmpireInsights Lead Command Center inside the admin workspace: searchable purchased-lead warehouse, permanent archives, call-history/talk-time/disposition filters, pagination, bulk archive/restore/DNC/advisor assignment, and list creation from selected leads or an entire filtered view.
- Reusable `Filter IN` and `Filter OUT` rules for state, country, status, disposition, advisor, campaign, list, source, destination/resort, attempts, talk time, imported date, last-contact date, and archive status. Filters saved for `Live dialing protection` immediately control which records can enter the dialer; saved admin views do not alter dialing.
- Campaign creation, named CSV lead-list import, deterministic even splitting, advisor pools, shared lists, supplemental random blending, reservation locking, callback ownership, retry scheduling, duplicate protection, and global DNC suppression.
- CSV cleanup during import: phone normalization, name cleanup, invalid-email removal, country normalization, two-digit purchase-date normalization, and State derivation from ZIP when a State column is absent.
- Advisor-selectable today, weekly, and all-time commission display. Commission amounts populate when a lead contains a mapped `Commission amount` value and is dispositioned as Sale.
- Optional Mason transcription and coaching for connected calls.

New data files are created automatically inside the existing `/data` volume: `layout.json`, `leads.json`, `lead-lists.json`, `lead-filters.json`, and `dnc.json`. The warehouse record remains available for reporting even after a lead is completed, suppressed, or archived.

## Import the supplied HGV list

1. Sign in as Jake and open **Admin → Lead Command Center → Import Purchased Leads**.
2. Select `TNB TITTIES.csv`. The known columns automatically map to Phone, first/last name, email, address, city, ZIP, country, last purchase, and prior destination.
3. Leave **Distribution** set to **Split evenly among selected advisors**. Dave (Ext 1001) and Nick (Ext 1002) are preselected.
4. Click **Import Lead List**. The verified result is **9,983 imported: Dave 4,992 and Nick 4,991**.
5. To block a market, create a rule such as `State equals VA` or `Country equals Canada`, choose **Filter OUT**, select **Live dialing protection**, name it, and save it. No geographic exclusion is enabled automatically.

Selecting the DNC disposition or the Lead Command Center's **Add to global DNC** bulk action immediately suppresses the phone across all lists, removes it from the callable pool, and writes it to `dnc.json`. The warehouse record is retained as an audit entry, and later imports of that number are skipped.

## Optional Mason setup

Mason remains visibly disabled until the container receives an OpenAI API key. Do not paste the key into chat. Add these variables to the app service in `docker-compose.yml` using the server's existing secret-management method:

```yaml
environment:
  OPENAI_API_KEY: ${OPENAI_API_KEY}
  OPENAI_MASON_MODEL: gpt-5.6-luna
  OPENAI_TRANSCRIPTION_MODEL: gpt-transcribe
```

Then rebuild the container. Without the key, calling, queues, lead lists, notes, layouts, and transfers continue to work; only Mason is unavailable.

## Acceptance check

1. Dave signs in as advisor, Ext 1001; Nick signs in as advisor, Ext 1002; Jake signs in as admin, Ext 1003.
2. Dave and Nick do not see the Admin section.
3. Each advisor can join/leave `incoming-sales`, place a call, receive an automatically connected call, hear the beep, use DTMF, and end the call.
4. During a connected call, TO lists available advisors and Jake as Manager TO.
5. Admin can save a reordered layout, import a CSV with an even advisor split, filter the warehouse, save a dialing exclusion, archive/restore leads, and create a new list from a filtered view.
6. That advisor loads the lead, notes autosave, and a disposition releases or reschedules it correctly.

## Boundary

The Power Dial button automatically advances through reserved leads one at a time. Automatic human-versus-voicemail detection requires a separate Asterisk AMD/dialplan deployment because the Asterisk configuration was not part of the supplied source archive. This package does not falsely label that infrastructure change as complete.

The Lead Command Center is available today inside EmpireConnection admin and is reached through the existing EmpireInsights SSO. Adding it as a native menu page inside the separate EmpireInsights WordPress application requires that CRM plugin/theme source; that source was not included in the supplied dialer archive, so this package does not falsely claim that WordPress-side menu integration.
