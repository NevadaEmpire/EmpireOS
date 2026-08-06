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

        tbody.replaceChildren();

        if (!calls.length) {

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

            row.appendChild(
                createCell(
                    new Date(call.startedAt).toLocaleString()
                )
            );

            row.appendChild(
                createCell(call.fullName)
            );

            row.appendChild(
                createCell(call.phone)
            );

            row.appendChild(
                createCell(
                    call.campaignName || call.campaignId
                )
            );

            row.appendChild(
                createCell(call.disposition)
            );

            row.appendChild(
                createCell(
                    formatDuration(call.duration)
                )
            );

            const actions = document.createElement("td");

            actions.innerHTML = `
                <button class="open-lead"
                        data-lead="${call.leadId}">
                    Open Lead
                </button>

                <button class="call-again"
                        data-phone="${call.phone}">
                    Call Again
                </button>
            `;

            row.appendChild(actions);

            tbody.appendChild(row);

        }

        tbody.querySelectorAll(".call-again").forEach((button) => {

            button.addEventListener("click", () => {

                const destination = $("#destination");

                if (!destination) return;

                destination.value = button.dataset.phone;

                destination.focus();

            });

        });

        tbody.querySelectorAll(".open-lead").forEach((button) => {

            button.addEventListener("click", () => {

                console.log(
                    "Open Lead:",
                    button.dataset.lead
                );

            });

        });

    } catch (error) {

        console.error(error);

        tbody.innerHTML = `
            <tr>
                <td colspan="7"
                    style="text-align:center;color:red;padding:20px;">
                    Failed loading Call History.
                </td>
            </tr>
        `;

    }

}