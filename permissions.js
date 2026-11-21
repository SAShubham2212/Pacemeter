document.getElementById('check-btn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    status.style.color = '#34D399';
    status.textContent = 'Microphone verified. You can close this tab and launch PaceMeter on Google Meet, Zoom, or Teams.';
  } catch (err) {
    status.style.color = '#F87171';
    status.textContent = 'Permission blocked: ' + (err && err.message ? err.message : 'Check browser site settings.');
  }
});
