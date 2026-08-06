import fs from "node:fs";

function readJson(file, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readActivity(activityPath) {
  if (!fs.existsSync(activityPath)) return [];

  return fs
    .readFileSync(activityPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function loadCallHistory(activityPath, leadsPath, username) {

  const activity = readActivity(activityPath);

  const leads = readJson(leadsPath, []);

  const leadLookup = new Map();

  for (const lead of leads) {
    leadLookup.set(String(lead.id), lead);
  }

  const activeCalls = new Map();

  const history = [];

  for (const event of activity) {

    if (event.user !== username)
      continue;

    switch (event.type) {

      case "call_started":

        activeCalls.set(String(event.leadId), {
          startedAt: event.at,
          destination: event.destination,
          direction: event.direction
        });

        break;

      case "disposition": {

        const leadId = String(event.leadId);

        const call =
          activeCalls.get(leadId) || {};

        const lead =
          leadLookup.get(leadId) || {};
        history.unshift({

          leadId,

          startedAt:
            call.startedAt || event.at,

          endedAt:
            event.at,

          direction:
            call.direction || "outbound",

          duration: "",

          firstName:
            lead.firstName || "",

          lastName:
            lead.lastName || "",

          fullName:
            lead.fullName ||
            `${lead.firstName || ""} ${lead.lastName || ""}`.trim(),

          spouseName:
            lead.spouseName ||
            lead.custom?.spouseName ||
            "",

          phone:
            lead.phone || "",

          alternatePhone:
            lead.alternatePhone || "",

          email:
            lead.email || "",

          secondEmail:
            lead.secondEmail ||
            lead.custom?.secondEmail ||
            "",

          address:
            lead.address || "",

          city:
            lead.city || "",

          state:
            lead.state || "",

          zip:
            lead.zip || "",

          campaignId:
            lead.campaignId || "",

          source:
            lead.source || "",

          disposition:
            lead.dispositionLabel ||
            event.disposition ||
            "",

          notes:
            lead.notes || "",

          destination:
            lead.phone ||
            call.destination ||
            ""

        });

        activeCalls.delete(leadId);

        break;
      }
    }

  }

  history.sort((a, b) => {

    const aTime = new Date(a.startedAt || 0).getTime();

    const bTime = new Date(b.startedAt || 0).getTime();

    return bTime - aTime;

  });

  return history;

}

