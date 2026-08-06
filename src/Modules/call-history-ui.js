export async function refreshCallHistory() {

    const tbody = document.querySelector("#call-history-body");

    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="7" style="text-align:center;padding:25px;">
                Loading call history...
            </td>
        </tr>
    `;

    try {

        const response = await fetch("/api/calls/history", {
            credentials: "same-origin"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const { calls } = await response.json();

        if (!calls || calls.length === 0) {

            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center;padding:25px;">
                        No conversations found.
                    </td>
                </tr>
            `;

            return;
        }

        tbody.innerHTML = "";

        for (const call of calls) {

            const row = document.createElement("tr");

            row.innerHTML = `
                <td>${new Date(call.startedAt).toLocaleString()}</td>
                <td>${call.fullName ?? ""}</td>
                <td>${call.phone ?? ""}</td>
                <td>${call.campaignName ?? call.campaignId ?? ""}</td>
                <td>${call.disposition ?? ""}</td>
                <td>${formatDuration(call.duration)}</td>
                <td>
                    <button
                        class="open-lead-button"
                        data-lead="${call.leadId}">
                        Open Lead
                    </button>
                </td>
            `;

            tbody.appendChild(row);

        }

        tbody.querySelectorAll(".open-lead-button").forEach((button) => {

            button.addEventListener("click", () => {

                console.log("Open Lead", button.dataset.lead);

                // CRM navigation goes here next commit.

            });

        });

    } catch (error) {

        console.error(error);

        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;padding:25px;color:red;">
                    Failed loading Call History.
                </td>
            </tr>
        `;

    }

}