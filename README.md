# Travel Empire Dialer

This release is a deployable, CRM-themed dialer foundation for `dialer.travelempire.org`.

## Included now

- Travel Empire logo and crown favicon, deep navy theme, solid-gold accents, CRM green call controls, and burgundy destructive controls.
- CRM-only HMAC single sign-on—there is no separate dialer password page.
- Dave Sterling / extension 1001, Nick Zurko / 1002, Jake Adams / 1003, with 1004 available for demonstration.
- Browser calling through Asterisk WebRTC, incoming queue join/leave controls, and administrator queue assignment.
- Side-by-side vacation reference and per-campaign script workspace.
- Disposition interface with required language detail and CRM email-template selection.
- Reporting dashboard shell, activity event collection, advisor status tracking, and campaign/disposition data foundations.
- CSV lead-mapping workflow with quoted-field parsing, automatic standard-field matching, sample-value preview, required fields, custom call fields, and reusable per-campaign mapping profiles.
- Asterisk IVR, queue prompts, hold music, direct extensions, advisor voicemail prompts, after-hours routing, broadcast press-1 and press-9 DNC flow.
- Mason AI governance placeholder; no autonomous learning or live AI calling is enabled until a reviewed script and consent/compliance design are approved.

## Install

Upload and extract the release archive on the existing dialer server, then run:

    chmod +x install.sh
    sudo ./install.sh

Then install `wordpress-plugin/travel-empire-dialer-sso.php` in the CRM and put the same private HMAC secret in WordPress as documented in `wordpress-plugin/README.md`.

## Important scope boundary

The screens and storage foundations for campaigns, leads, rules, reporting, email actions, commissions, and activity are present. CSV files can be inspected and mapped, and the mapping profiles are saved; inserting mapped records into the production CRM, deduplication, DNC screening, predictive pacing, AMD, CRM email sending, payment links, commission calculations, callback scheduling, warm transfers, and Mason still require the CRM data/API contract plus end-to-end compliance testing. The UI never presents unfinished controls as live telephony actions.

The desired public number is **725-205-3208**. The existing Telnyx numbers observed during setup are **725-224-9003** and **725-224-9004**. Do not publish or originate with 725-205-3208 until it is owned/ported and routed in Telnyx.
