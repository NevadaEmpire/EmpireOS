function $(selector) {
    return document.querySelector(selector);
}

function formatDuration(seconds) {

    seconds = Number(seconds || 0);

    const minutes = Math.floor(seconds / 60);

    const remaining = seconds % 60;

    return `${minutes}:${String(remaining).padStart(2, "0")}`;

}

function createCell(text) {

    const td = document.createElement("td");

    td.textContent = text ?? "";

    return td;

}
export async function refreshCallHistory() {

    const tbody = $("#call-history-body");

    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="7" style="text-align:center;padding:20px;">
                Loading Call History...
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

        tbody.replaceChildren();

        if (!calls || !calls.length) {

            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center;padding:20px;">
                        No conversations found.
                    </td>
                </tr>
            `;

            return;

        }

        for (const call of calls) {

            const row = document.createElement("tr");

            row.appendChild(createCell(new Date(call.startedAt).toLocaleString()));
            row.appendChild(createCell(call.fullName));
            row.appendChild(createCell(call.phone));
            row.appendChild(createCell(call.campaignName || call.campaignId));
            row.appendChild(createCell(call.disposition));
            row.appendChild(createCell(formatDuration(call.duration)));

            const actions = document.createElement("td");

            actions.innerHTML = `
                <div class="call-history-actions">
                    <button class="history-button history-view" data-lead="${call.leadId}">
                        View
                    </button>

                    <button class="history-button history-call" data-phone="${call.phone}">
                        Call
                    </button>
                </div>
            `;

            row.appendChild(actions);

            tbody.appendChild(row);

        }

        tbody.querySelectorAll(".history-call").forEach((button) => {

            button.addEventListener("click", () => {

                const destination = $("#destination");

                if (!destination) return;

                destination.value = button.dataset.phone || "";

                destination.focus();

            });

        });

        tbody.querySelectorAll(".history-view").forEach((button) => {

            button.addEventListener("click", () => {

                console.log("Open Lead", button.dataset.lead);

            });

        });

    } catch (error) {

        console.error(error);

        tbody.innerHTML = `
            <tr>
                <td colspan="7" style="text-align:center;color:red;padding:20px;">
                    Failed loading Call History.
                </td>
            </tr>
        `;

    }

}
