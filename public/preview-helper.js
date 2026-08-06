(() => {
  let ctx = null;
  let ringTimer = null;
  let countdownTimer = null;
  let remaining = 25;

  const $ = (selector) => document.querySelector(selector);

  function ringBurst() {
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      ctx ||= new AudioContext();
      if (ctx.state === "suspended") ctx.resume().catch(() => {});

      const start = ctx.currentTime + 0.01;
      [440, 480].forEach((freq, index) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        osc.connect(gain);
        gain.connect(ctx.destination);

        const t = start + index * 0.03;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.14, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.05);
        osc.start(t);
        osc.stop(t + 1.1);
      });
    } catch (_) {}
  }

  function stopPreviewHelper(message) {
    clearInterval(ringTimer);
    clearInterval(countdownTimer);
    ringTimer = null;
    countdownTimer = null;

    if (message && $("#record-state")) {
      $("#record-state").textContent = message;
    }
  }

  function startPreviewHelper() {
    stopPreviewHelper();

    remaining = 25;
    ringBurst();
    ringTimer = setInterval(ringBurst, 3000);

    const tick = () => {
      const phone = String($("#phone-status")?.textContent || "").toLowerCase();
      const record = String($("#record-state")?.textContent || "").toLowerCase();

      if (phone.includes("on call") || phone.includes("active") || record.includes("select a disposition")) {
        stopPreviewHelper();
        return;
      }

      if ($("#record-state")) {
        $("#record-state").textContent = `CALLING · ${remaining} SEC`;
      }

      if (remaining <= 0) {
        stopPreviewHelper("TIMEOUT · CHOOSE NA OR VM");
        return;
      }

      remaining -= 1;
    };

    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest('.dial-mode-button[data-dial-mode="preview"]')) {
      setTimeout(startPreviewHelper, 250);
    }

    if (event.target.closest("#hangup-button, #disposition-rail .disp")) {
      stopPreviewHelper();
    }
  }, true);
})();
