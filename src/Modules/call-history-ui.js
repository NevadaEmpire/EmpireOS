export async function refreshCallHistory() {
    try {

        const result = await fetch("/api/calls/history", {
            credentials: "same-origin"
        });

        if (!result.ok) {
            console.error("Call History API:", result.status);
            return;
        }

        const data = await result.json();

        console.log("CALL HISTORY", data);

    } catch (error) {

        console.error("Call History Error", error);

    }
}